import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import fs from 'fs';
import yaml from 'js-yaml';
import * as request from 'request';

const configFile = 'config.yaml';
const config = yaml.load(fs.readFileSync(configFile, 'utf8'));

const {igName, vpc_config, region, publicRouteTableConfig,baseMask, EC2, securityGroup, digitalocean } = config;

const baseIp= "10.0";
const privateSubnets=[]
const publicSubnets=[]

const vpc = new aws.ec2.Vpc("main",
    {
        cidrBlock: vpc_config['Cidr'],
        tags: {
            Name: vpc_config['Name'],
        },      
});

const generateCidrBlock =(baseIp,baseMask,index)=>{
    return `${baseIp}.${index}.0${baseMask}`;
}

const gateway = new aws.ec2.InternetGateway("gw", {
    tags: {
        Name: igName,
    },
});

const internetGatewayAttachment = new aws.ec2.InternetGatewayAttachment("exampleInternetGatewayAttachment", {
    internetGatewayId: gateway.id,
    vpcId: vpc.id,
    tags: {
        Name: igName,
    }   
});

const availableAZs = await aws.getAvailabilityZones({ state: "available", region: region });

function calculateCidrBlock(index, subnetType){

    const base = subnetType === "public" ? 0 : 10; // different ranges for public and private
    const max = 255;
    const mask = "/24";
    let calculated = index + base;
    if (calculated >= max) {
        throw new Error('Exceeded the maximum IP range');
    }
    return `10.0.${calculated}.0${mask}`;
}

let subnetCount =0;
availableAZs.names.forEach((az, index) => {
    if(subnetCount<3){
        const publicSubnet = new aws.ec2.Subnet(`publicSubnet${index}`, {
            vpcId: vpc.id,
            availabilityZone: az,
            cidrBlock: calculateCidrBlock(index, "public"),
            mapPublicIpOnLaunch: true,
            tags: {
                Name: `PublicSubnet${index}`,
            },
        }, {dependsOn:[vpc]});

        
        const privateSubnet = new aws.ec2.Subnet(`privateSubnet${index}`, {
            vpcId: vpc.id,
            availabilityZone: az,
            cidrBlock: calculateCidrBlock(index, "private"),
            mapPublicIpOnLaunch: true,
            tags: {
                Name: `PrivateSubnet${index}`,
            },
        }, {dependsOn:[vpc]});

        publicSubnets.push(publicSubnet)
        privateSubnets.push(privateSubnet)
    
        subnetCount++;
} 
    else 
    {
        return;
    }   
});

//creating public route table
const publicRouteTable = new aws.ec2.RouteTable('publicRouteTable', {
    vpcId: vpc.id,
    tags: {
        Name: "publicRouteTable",
    }  
});

publicSubnets.slice(0, subnetCount+1).forEach((publicSubnet, index) => {
    const subnetAssociation = new aws.ec2.RouteTableAssociation(`publicSubnetAssociation${index}`, {
        subnetId: publicSubnet.id,
        routeTableId: publicRouteTable.id,
    });
});


const privateRouteTable = new aws.ec2.RouteTable('privateRouteTable', {
    vpcId: vpc.id,
    tags: {
        Name: "privateRouteTable",
    }  
});
            

privateSubnets.forEach((privateSubnet, index) => {
    const subnetAssociation = new aws.ec2.RouteTableAssociation(`privateSubnetAssociation${index}`, {
        subnetId: privateSubnet.id,
        routeTableId: privateRouteTable.id,
    });
});

const publicRoute = new aws.ec2.Route('publicRoute', {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: publicRouteTableConfig['Cidr'],
    gatewayId: gateway.id,   
});

//app security group for EC2 instance
const appSecurityGroup = new aws.ec2.SecurityGroup("app-security-group", {
    vpcId: vpc.id,
    ingress: [
        {
            fromPort: securityGroup['sshPort'],
            toPort: securityGroup['sshPort'],
            protocol: securityGroup['protocol'],
            cidrBlocks: [securityGroup['Cidr']],
        },
        {
            fromPort: securityGroup['trafficPort80'],
            toPort: securityGroup['trafficPort80'],
            protocol: securityGroup['protocol'],
            cidrBlocks: [securityGroup['Cidr']],
        },
        {
            fromPort:securityGroup['trafficPort443'],
            toPort: securityGroup['trafficPort443'],
            protocol: securityGroup['protocol'],
            cidrBlocks: [securityGroup['Cidr']],
        },

        {
            fromPort:securityGroup['localPort'] ,
            toPort: securityGroup['localPort'],
            protocol: securityGroup['protocol'],
            cidrBlocks: [securityGroup['Cidr']],
        },
    ],
    egress: [
        {
            protocol: 'tcp',
            fromPort: 3306, 
            toPort: 3306,   
            cidrBlocks: ['0.0.0.0/0']
        },
        {
            protocol: 'tcp',
            fromPort: 443, 
            toPort: 443,   
            cidrBlocks: ['0.0.0.0/0']
        },
    ],
});
    
    //creating key value pair for ssh
const keyPair = new aws.ec2.KeyPair("digitalocean", {
    publicKey: digitalocean
});

//creating DB security group which which will be connected to private subnet
const dbSecurityGroup = new aws.ec2.SecurityGroup("dbSecurityGroup",{
    vpcId: vpc.id,
    ingress : [
        {   
            protocol:"tcp",
            fromPort:3306,
            toPort: 3306,
            securityGroups: [appSecurityGroup.id],
            cidrBlocks: ['0.0.0.0/0'],
        },
    ],
});

//creating parameter group
const dbParamterGroup= new aws.rds.ParameterGroup("db-parameter-group",{
    family: "mariadb10.11",   
})

//creating a dbSubnetGroup
const dbSubnetGroup = new aws.rds.SubnetGroup("my-db-subnetgroup",{
    subnetIds:privateSubnets.map(subnet=>subnet.id),
});


//creating rds instance
const rdsInstance= new aws.rds.Instance("my-mariadb-instance",{

    allocatedStorage:20,
    engine: "mariadb",
    engineVersion: "10.11.4",
    instanceClass:"db.t3.micro",
    multiAz: false,
    parameterGroupName:dbParamterGroup.name,
    dbName: "health",
    username: "admin",
    password: "root1234",
    dbSubnetGroupName: dbSubnetGroup.name,
    publiclyAccessible:false,
    vpcSecurityGroupIds: [dbSecurityGroup.id],
    skipFinalSnapshot: true,

});


const userDataScript = pulumi.interpolate`#!/bin/bash
echo "HOST=${rdsInstance.endpoint.apply(endpoint => endpoint.split(":")[0])}" >> /etc/environment
echo "USER=admin" >> /etc/environment
echo "DATABASE=health" >> /etc/environment
echo "PASSWORD=root1234" >> /etc/environment
echo "DATABASE_PORT=3306" >> /etc/environment
echo "DIALECT=mariadb" >> /etc/environment
echo "DEFAULTUSERPATH=/opt/users.csv" >> /etc/environment
# Configure the CloudWatch Agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config \
    -m ec2 \
    -c file:/home/admin/webapp/cloudwatch-config.json \
    -s
source /etc/environment
`
// IAM Role for EC2
const ec2Role = new aws.iam.Role("my-instance-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
});

const ssmPolicyAttachment = new aws.iam.RolePolicyAttachment("ssmPolicyAttachment", {
    role: ec2Role.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

// Attach the CloudWatchAgentServerPolicy policy to the role for CloudWatch
const cloudWatchPolicyAttachment = new aws.iam.RolePolicyAttachment("cloudWatchPolicyAttachment", {
    role: ec2Role.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

//instance profile for ec2
const instanceProfile = new aws.iam.InstanceProfile("ec2instanceProfile", {
    role: ec2Role,
});

const DNSZone = aws.route53.getZone({ name: "dev.gloriasingh.me." }, { async: true });

const ec2Instance = new aws.ec2.Instance("my-ec2-instance", {
    
    ami: EC2['amiId'], 
    iamInstanceProfile: instanceProfile.name,
    instanceType: EC2['instanceType'], 
    vpcSecurityGroupIds: [appSecurityGroup.id],
    subnetId: publicSubnets[0].id,
    keyName: keyPair.keyName,
    associatePublicIpAddress: true,
    rootBlockDevice: {
        volumeSize: EC2['rootVolume'],
        volumeType: EC2['rootVolumeTyoe'],
        deleteOnTermination: true,
    },
    disableApiTermination: false,
    tags: {
        Name: "MyEC2Instance6225",
    },
    userData: userDataScript,
});

// Create a DNS record
DNSZone.then(zone => {
    const aRecord = new aws.route53.Record("DNS-a-record", {
      zoneId: zone.zoneId,
      name: "dev.gloriasingh.me",
      type: "A",
      ttl: 60,
      records: [ec2Instance.publicIp],
    });
  });

export default ec2Instance
