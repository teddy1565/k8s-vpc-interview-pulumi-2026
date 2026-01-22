import * as pulumi from "@pulumi/pulumi";
import { EksVpc } from "./eks_vpc"; // 假設上面的程式碼存檔為 EksVpc.ts

const config = new pulumi.Config();

const vpcName = config.get("vpcName") || "eks-vpc";
const certArn = config.get("clientVpnCertificateArn");

const myNetwork = new EksVpc(vpcName, {
    vpcCidr: config.get("vpcCidr"),
    clusterName: config.get("clusterName"),
    azCount: config.getNumber("azCount"),
    clientVpnCertificateArn: certArn,
});

export const vpcId = myNetwork.vpcId;
export const publicSubnets = myNetwork.publicSubnetIds;
export const privateSubnets = myNetwork.privateSubnetIds;
export const vpnId = myNetwork.vpnEndpointId;
