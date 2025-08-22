// aws-infra/lib/ktx-waiting-room-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class KtxWaitingRoomStack extends cdk.Stack {
public readonly albDnsName: string;
public readonly backendEcrUri: string;
public readonly frontendEcrUri: string;

constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC 생성 - CIDR 10.6.0.0/16으로 설정
    const vpc = new ec2.Vpc(this, 'KtxWaitingRoomVPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.6.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // 비용 최적화를 위해 1개만
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ECR 리포지토리 생성
    const backendRepo = new ecr.Repository(this, 'BackendRepo', {
      repositoryName: 'ktx-waiting-room-backend',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const frontendRepo = new ecr.Repository(this, 'FrontendRepo', {
      repositoryName: 'ktx-waiting-room-frontend',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ElastiCache Redis 서브넷 그룹
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis cluster',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    // Redis 보안 그룹
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'Security group for Redis cluster',
      allowAllOutbound: false,
    });

    // ElastiCache Redis 클러스터
    const redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      cacheNodeType: 'cache.t3.micro',
      engine: 'redis',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      cacheSubnetGroupName: redisSubnetGroup.ref,
      port: 6379,
    });

    // ECS 클러스터
    const cluster = new ecs.Cluster(this, 'KtxWaitingRoomCluster', {
      vpc,
      clusterName: 'ktx-waiting-room-cluster',
    });

    // CloudWatch 로그 그룹
    const backendLogGroup = new logs.LogGroup(this, 'BackendLogGroup', {
      logGroupName: '/ecs/ktx-waiting-room-backend',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const frontendLogGroup = new logs.LogGroup(this, 'FrontendLogGroup', {
      logGroupName: '/ecs/ktx-waiting-room-frontend',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Backend Task Definition
    const backendTaskDefinition = new ecs.FargateTaskDefinition(this, 'BackendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    const backendContainer = backendTaskDefinition.addContainer('BackendContainer', {
      image: ecs.ContainerImage.fromEcrRepository(backendRepo, 'latest'),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        REDIS_URL: `redis://${redisCluster.attrRedisEndpointAddress}:${redisCluster.attrRedisEndpointPort}`,
        MAX_CONCURRENT_USERS: '20',
        SESSION_DURATION: '600000',
        JWT_SECRET: 'production-jwt-secret-change-this',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'backend',
        logGroup: backendLogGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    backendContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // Frontend Task Definition
    const frontendTaskDefinition = new ecs.FargateTaskDefinition(this, 'FrontendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    const frontendContainer = frontendTaskDefinition.addContainer('FrontendContainer', {
      image: ecs.ContainerImage.fromEcrRepository(frontendRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'frontend',
        logGroup: frontendLogGroup,
      }),
    });

    frontendContainer.addPortMappings({
      containerPort: 80,
      protocol: ecs.Protocol.TCP,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'KtxWaitingRoomALB', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'ktx-waiting-room-alb',
    });

    const listener = alb.addListener('PublicListener', {
      port: 80,
      open: true,
    });

    // ECS Services
    const backendService = new ecs.FargateService(this, 'BackendService', {
      cluster,
      taskDefinition: backendTaskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      serviceName: 'ktx-backend-service',
      enableExecuteCommand: true,
    });

    const frontendService = new ecs.FargateService(this, 'FrontendService', {
      cluster,
      taskDefinition: frontendTaskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      serviceName: 'ktx-frontend-service',
    });

    // Target Groups
    const backendTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BackendTargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    const frontendTargetGroup = new elbv2.ApplicationTargetGroup(this, 'FrontendTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
    });

    // ALB 라우팅 규칙
    listener.addTargetGroups('DefaultTargetGroup', {
      targetGroups: [frontendTargetGroup],
    });

    listener.addAction('ApiRouting', {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*', '/health']),
      ],
      action: elbv2.ListenerAction.forward([backendTargetGroup]),
    });

    // 서비스를 타겟 그룹에 연결
    backendService.attachToApplicationTargetGroup(backendTargetGroup);
    frontendService.attachToApplicationTargetGroup(frontendTargetGroup);

    // 보안 그룹 설정
    backendService.connections.allowFrom(alb, ec2.Port.tcp(3000));
    frontendService.connections.allowFrom(alb, ec2.Port.tcp(80));

    // Redis 액세스 허용
    redisSecurityGroup.addIngressRule(
      backendService.connections.securityGroups[0],
      ec2.Port.tcp(6379),
      'Allow backend to access Redis'
    );

    // Auto Scaling 설정
    const backendScaling = backendService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 10,
    });

    backendScaling.scaleOnCpuUtilization('BackendCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(300),
    });

    const frontendScaling = frontendService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });

    frontendScaling.scaleOnCpuUtilization('FrontendCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(300),
    });

    // 출력값 설정
    this.albDnsName = alb.loadBalancerDnsName;
    this.backendEcrUri = backendRepo.repositoryUri;
    this.frontendEcrUri = frontendRepo.repositoryUri;

    // CloudFormation 출력
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
      description: 'Load Balancer DNS Name',
      exportName: 'KtxWaitingRoom-ALB-DNS',
    });

    new cdk.CfnOutput(this, 'BackendECRRepository', {
      value: backendRepo.repositoryUri,
      description: 'Backend ECR Repository URI',
      exportName: 'KtxWaitingRoom-Backend-ECR',
    });

    new cdk.CfnOutput(this, 'FrontendECRRepository', {
      value: frontendRepo.repositoryUri,
      description: 'Frontend ECR Repository URI',
      exportName: 'KtxWaitingRoom-Frontend-ECR',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: redisCluster.attrRedisEndpointAddress,
      description: 'Redis Cluster Endpoint',
      exportName: 'KtxWaitingRoom-Redis-Endpoint',
    });

    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `http://${alb.loadBalancerDnsName}`,
      description: 'Website URL',
      exportName: 'KtxWaitingRoom-Website-URL',
    });

    new cdk.CfnOutput(this, 'ApiURL', {
      value: `http://${alb.loadBalancerDnsName}/api`,
      description: 'API URL',
      exportName: 'KtxWaitingRoom-API-URL',
    });
  }
}