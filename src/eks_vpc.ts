import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EksVpcArgs {
    vpcCidr?: string;
    clusterName?: string;
    azCount?: number;
    clientVpnCertificateArn?: string;
    tags?: { [key: string]: string };
}

export class EksVpc extends pulumi.ComponentResource {
    public readonly vpcId: pulumi.Output<string>;
    public readonly publicSubnetIds: pulumi.Output<string>[] = [];
    public readonly privateSubnetIds: pulumi.Output<string>[] = [];
    public readonly vpnEndpointId: pulumi.Output<string> | undefined;

    constructor(name: string, args: EksVpcArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:network:EksVpc", name, {}, opts);

        const vpcCidr = args.vpcCidr || "10.0.0.0/16";
        const clusterName = args.clusterName || "interview-k8s-cluster";
        const azCount = args.azCount || 2;
        const region = aws.config.region;

        const availableZones = aws.getAvailabilityZones({ state: "available" });

        // VPC
        const vpc = new aws.ec2.Vpc(name, {
            cidrBlock: vpcCidr,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            tags: {
                name: name,
                vpc_name: name,
                [`kubernetes.io/cluster/${clusterName}`]: "shared",
                ...args.tags,
            }
        }, { parent: this });

        this.vpcId = vpc.id;

        // Internet Gateway
        const internetGateway = new aws.ec2.InternetGateway(`${name}-igw-a`, {
            vpcId: vpc.id,
            tags: {
                [`${name}:internet-gateway`]: `${name}-igw-a`,
                [`${name}:igw`]: `${name}-igw-a`
            }
        }, { parent: this });

        // Subnets loop
        for (let i = 0; i < azCount; i++) {
            const azName = pulumi.output(availableZones).apply(z => z.names[i % z.names.length]);

            // Public Subnet
            const pubSubnet = new aws.ec2.Subnet(`${name}-public-${i}`, {
                vpcId: vpc.id,
                cidrBlock: `10.0.${i}.0/24`,
                availabilityZone: azName,
                mapPublicIpOnLaunch: true,
                tags: {
                    [`${name}:subnet-public`]: `${name}-subnet-public-${i}`,
                    [`kubernetes.io/role/elb`]: "1",
                    [`kubernetes.io/cluster/${clusterName}`]: "shared"
                }
            }, { parent: this });

            this.publicSubnetIds.push(pubSubnet.id);

            // Public Route Table
            const publicRouteTable = new aws.ec2.RouteTable(`${name}-public-route-table-${i}`, {
                vpcId: vpc.id,
                routes: [
                    {
                        cidrBlock: "0.0.0.0/0",
                        gatewayId: internetGateway.id
                    }
                ],
                tags: {
                    [`${name}:route-table-public`]: `${name}-route-table-public-${i}`
                }
            }, { parent: this });

            new aws.ec2.RouteTableAssociation(`${name}-public-route-table-assoc-${i}`, {
                subnetId: pubSubnet.id,
                routeTableId: publicRouteTable.id
            }, { parent: this });

            // NAT Gateway & EIP
            const eip = new aws.ec2.Eip(`${name}-nat-eip-${i}`, {
                domain: "vpc"
            }, { parent: this });

            const natGateway = new aws.ec2.NatGateway(`${name}-nat-gateway-${i}`, {
                allocationId: eip.id,
                subnetId: pubSubnet.id,
                tags: {
                    [`${name}:nat-gateway`]: `${name}-nat-gateway-${i}`
                }
            }, { parent: this });

            // Private Subnet
            const privateSubnet = new aws.ec2.Subnet(`${name}-private-${i}`, {
                vpcId: vpc.id,
                cidrBlock: `10.0.${(i + 1) * 16}.0/20`,
                availabilityZone: azName,
                tags: {
                    [`${name}:subnet-private`]: `${name}-subnet-private-${i}`,
                    [`kubernetes.io/role/internal-elb`]: "1",
                    [`kubernetes.io/cluster/${clusterName}`]: "shared",
                    "karpenter.sh/discovery": clusterName
                }
            }, { parent: this });

            this.privateSubnetIds.push(privateSubnet.id);

            // Private Route Table
            const privateRouteTable = new aws.ec2.RouteTable(`${name}-private-route-table-${i}`, {
                vpcId: vpc.id,
                routes: [
                    {
                        cidrBlock: "0.0.0.0/0",
                        natGatewayId: natGateway.id,
                    }
                ],
                tags: {
                    [`${name}:route-table-private`]: `${name}-route-table-private-${i}`
                }
            }, { parent: this });

            new aws.ec2.RouteTableAssociation(`${name}-private-route-table-assoc-${i}`, {
                subnetId: privateSubnet.id,
                routeTableId: privateRouteTable.id
            }, { parent: this });
        }

        // SSM Endpoints
        const ssmSg = new aws.ec2.SecurityGroup(`${name}-ssm-endpoint-sg`, {
            vpcId: vpc.id,
            description: "Security Group for SSM Endpoints",
            ingress: [
                {
                    protocol: "tcp",
                    fromPort: 443,
                    toPort: 443,
                    cidrBlocks: [vpc.cidrBlock],
                }
            ],
            egress: [
                {
                    protocol: "-1",
                    fromPort: 0,
                    toPort: 0,
                    cidrBlocks: ["0.0.0.0/0"],
                }
            ],
            tags: {
                [`${name}:ssm-endpoint-sg`]: `${name}-ssm-endpoint-sg`
            }
        }, { parent: this });

        ["ssm", "ssmmessages", "ec2messages"].forEach((serviceName) => {
            new aws.ec2.VpcEndpoint(`${name}-ssm-endpoint-${serviceName}`, {
                vpcId: vpc.id,
                serviceName: `com.amazonaws.${region}.${serviceName}`,
                vpcEndpointType: "Interface",
                subnetIds: this.privateSubnetIds,
                privateDnsEnabled: true,
                securityGroupIds: [ssmSg.id],
                tags: {
                    [`${name}:ssm-endpoint`]: `${name}-ssm-endpoint-${serviceName}`
                }
            }, { parent: this });
        });

        // Client VPN
        if (args.clientVpnCertificateArn && args.clientVpnCertificateArn.length > 0) {
            const clientVpn = new aws.ec2clientvpn.Endpoint(`${name}-devops-vpn`, {
                description: "VPN for devops",
                serverCertificateArn: args.clientVpnCertificateArn,
                clientCidrBlock: "10.100.0.0/22",
                splitTunnel: true,
                authenticationOptions: [
                    {
                        type: "certificate-authentication",
                        rootCertificateChainArn: args.clientVpnCertificateArn
                    }
                ],
                connectionLogOptions: { enabled: false },
                tags: {
                    [`${name}:client-vpn-endpoint`]: `${name}-client-vpn-endpoint`
                }
            }, { parent: this });

            this.vpnEndpointId = clientVpn.id;

            // VPN Associations
            for (let i = 0; i < this.privateSubnetIds.length; i++) {
                new aws.ec2clientvpn.NetworkAssociation(`${name}-vpn-assoc-${i}`, {
                    clientVpnEndpointId: clientVpn.id,
                    subnetId: this.privateSubnetIds[i]
                }, { parent: this });
            }

            new aws.ec2clientvpn.AuthorizationRule(`${name}-vpc-auth-rule`, {
                clientVpnEndpointId: clientVpn.id,
                targetNetworkCidr: vpc.cidrBlock,
                authorizeAllGroups: true
            }, { parent: this });
        }

        this.registerOutputs({
            vpcId: this.vpcId,
            publicSubnetIds: this.publicSubnetIds,
            privateSubnetIds: this.privateSubnetIds,
            vpnEndpointId: this.vpnEndpointId,
        });
    }
}
