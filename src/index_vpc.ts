import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const config = new pulumi.Config();
const region = aws.config.region;
const vpc_name = config.get("vpcName") || "eks-vpc";
const vpc_cidr = config.get("vpcCidr") || "10.0.0.0/16";
const cluster_name = config.get("clusterName") || "interview-k8s-cluster";
const client_vpn_certificate_arn = config.get("clientVpnCertificateArn") || "";
const available_zones = aws.getAvailabilityZones({ state: "available" });
const az_count = config.get("azCount") ? parseInt(config.get("azCount") as string) : 2;

const vpc = new aws.ec2.Vpc(vpc_name, {
    cidrBlock: vpc_cidr,
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: {
        name: vpc_name,
        vpc_name: vpc_name,
        [`kubernetes.io/cluster/${cluster_name}`]: "shared"
    }
});

const internet_gateway = new aws.ec2.InternetGateway(`${vpc_name}-igw-a`, {
    vpcId: vpc.id,
    tags: {
        [`${vpc_name}:internet-gateway`]: `${vpc_name}-igw-a`,
        [`${vpc_name}:igw`]: `${vpc_name}-igw-a`
    }
});

export const public_subnet_ids: pulumi.Output<string>[] = [];
export const private_subnet_ids: pulumi.Output<string>[] = [];

for (let i = 0; i < az_count; i++) {
    const az_name = available_zones.then(z => z.names[i % z.names.length]);
    const pub_subnet = new aws.ec2.Subnet(`${vpc_name}-public-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i}.0/24`,
        availabilityZone: az_name,
        mapPublicIpOnLaunch: true,
        tags: {
            [`${vpc_name}:subnet-public`]: `${vpc_name}-subnet-public-${i}`,
            [`kubernetes.io/role/elb`]: "1",
            [`kubernetes.io/cluster/${cluster_name}`]: "shared"
        }
    });

    public_subnet_ids.push(pub_subnet.id);

    const public_route_table = new aws.ec2.RouteTable(`${vpc_name}-public-route-table-${i}`, {
        vpcId: vpc.id,
        routes: [
            {
                cidrBlock: "0.0.0.0/0",
                gatewayId: internet_gateway.id
            }
        ],
        tags: {
            [`${vpc_name}:route-table-public`]: `${vpc_name}-route-table-public-${i}`
        }
    });

    new aws.ec2.RouteTableAssociation(`${vpc_name}-public-route-table-assoc-${i}`, {
        subnetId: pub_subnet.id,
        routeTableId: public_route_table.id
    });

    const eip = new aws.ec2.Eip(`${vpc_name}-nat-eip-${i}`, {
        domain: "vpc"
    });
    const nat_gateway = new aws.ec2.NatGateway(`${vpc_name}-nat-gateway-${i}`, {
        allocationId: eip.id,
        subnetId: pub_subnet.id,
        tags: {
            [`${vpc_name}:nat-gateway`]: `${vpc_name}-nat-gateway-${i}`
        }
    });

    const private_subnet = new aws.ec2.Subnet(`${vpc_name}-private-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${(i + 1) * 16}.0/20`,
        availabilityZone: az_name,
        tags: {
            [`${vpc_name}:subnet-private`]: `${vpc_name}-subnet-private-${i}`,
            [`kubernetes.io/role/internal-elb`]: "1",
            [`kubernetes.io/cluster/${cluster_name}`]: "shared",
            "karpenter.sh/discovery": cluster_name
        }
    });

    private_subnet_ids.push(private_subnet.id);

    const private_route_table = new aws.ec2.RouteTable(`${vpc_name}-private-route-table-${i}`, {
        vpcId: vpc.id,
        routes: [
            {
                cidrBlock: "0.0.0.0/0",
                natGatewayId: nat_gateway.id,
            }
        ],
        tags: {
            [`${vpc_name}:route-table-private`]: `${vpc_name}-route-table-private-${i}`
        }
    });

    new aws.ec2.RouteTableAssociation(`${vpc_name}-private-route-table-assoc-${i}`, {
        subnetId: private_subnet.id,
        routeTableId: private_route_table.id
    });
}

const ssm_endpoint_security_group = new aws.ec2.SecurityGroup(`${vpc_name}-ssm-endpoint-security-group`, {
    vpcId: vpc.id,
    description: "",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: [vpc.cidrBlock],
            description: ""
        }
    ],
    egress: [
        {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
            description: ""
        }
    ],
    tags: {
        [`${vpc_name}:ssm-endpoint-sg`]: `${vpc_name}-ssm-endpoint-sg`
    }
});

const ssm_endpoints = ["ssm", "ssmmessages", "ec2messages"].map((service_name) => {
    return new aws.ec2.VpcEndpoint(`${vpc_name}-ssm-endpoint-${service_name}`, {
        vpcId: vpc.id,
        serviceName: `com.amazonaws.${region}.${service_name}`,
        vpcEndpointType: "Interface",
        subnetIds: private_subnet_ids,
        privateDnsEnabled: true,
        securityGroupIds: [ssm_endpoint_security_group.id],
        tags: {
            [`${vpc_name}:ssm-endpoint`]: `${vpc_name}-ssm-endpoint-${service_name}`
        }
    });
});

const client_vpn = new aws.ec2clientvpn.Endpoint(`${vpc_name}-devops-vpn`, {
    description: "VPN for devops",
    serverCertificateArn: client_vpn_certificate_arn,
    clientCidrBlock: "10.100.0.0/22",
    splitTunnel: true,
    authenticationOptions: [
        {
            type: "certificate-authentication",
            rootCertificateChainArn: client_vpn_certificate_arn
        }
    ],
    connectionLogOptions: {
        enabled: false  // interview simple, so disable
    },
    tags: {
        [`${vpc_name}:client-vpn-endpoint`]: `${vpc_name}-client-vpn-endpoint`
    }
});

for (let i = 0; i < private_subnet_ids.length; i++) {
    new aws.ec2clientvpn.NetworkAssociation(`vpn-assoc-${i}`, {
        clientVpnEndpointId: client_vpn.id,
        subnetId: private_subnet_ids[i]
    });
}

new aws.ec2clientvpn.AuthorizationRule("vpc-auth-rule", {
    clientVpnEndpointId: client_vpn.id,
    targetNetworkCidr: vpc.cidrBlock,
    authorizeAllGroups: true
});

export const vpnEndpointId = client_vpn.id;
export const vpcId = vpc.id;
export const vpcPublicSubnets = public_subnet_ids;
export const vpcPrivateSubnets = private_subnet_ids;
