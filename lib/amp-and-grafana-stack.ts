import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { aws_aps as aps } from 'aws-cdk-lib';
import { aws_grafana as grafana } from 'aws-cdk-lib';
import configBlob from '../config/config-blob';
import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';

export class AmpAndGrafanaStack extends cdk.Stack {
  private vpc: ec2.Vpc;
  private cluster: eks.Cluster;
  private prometheusWorkspace: aps.CfnWorkspace;
  private prometheusScraper: aps.CfnScraper;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = this.createVPC();
    this.cluster = this.createEKSCluster();
    this.prometheusWorkspace = this.createPrometheusWorkspace();
    this.prometheusScraper = this.createPromehtheusScraper();
    this.createPrometheusScraperRoleBinding();
    this.createGrafanaWorkspace();
  }

  private createVPC(): ec2.Vpc {
    return new ec2.Vpc(this, "VPC", {
      maxAzs: 3,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });
  }

  private createEKSCluster(): eks.Cluster {
    const kubectlLayer = new KubectlV30Layer(this, "KubectlLayer");

    // Create EKS Cluster
    const cluster = new eks.Cluster(this, "Cluster", {
      vpc: this.vpc,
      kubectlLayer,
      version: eks.KubernetesVersion.V1_30,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.AUDIT,
      ],
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
    });

    // Add Managed Node Group
    cluster.addNodegroupCapacity("ManagedNodeGroup", {
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE)],
      desiredSize: 1,
    });

    // OPTIONAL - add kube state metrics for more detailed monitoring
    // cluster.addHelmChart("KubeStateMetricsHelmChart", {
    //   chart: 'kube-state-metrics',
    //   release: 'kube-state-metrics',
    //   repository: 'https://kubernetes.github.io/kube-state-metrics',
    //   namespace: 'monitoring',
    // });

    return cluster
  }

  private createPrometheusWorkspace(): aps.CfnWorkspace {
    // Create prometheus workspace
    const prometheusWorkspace = new aps.CfnWorkspace(this, "PrometheusWorkspace", {
      alias: "my-prometheus-workspace",
    });

    return prometheusWorkspace;
  }

  private createPromehtheusScraper(): aps.CfnScraper {
    // Get EKS subnets
    const privateSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;

    // Create Prometheus scraper
    const prometheusScraper = new aps.CfnScraper(this, "PrometheusScraper", {
      destination: {
        ampConfiguration: {
          workspaceArn: this.prometheusWorkspace.attrArn,
        },
      },
      scrapeConfiguration: {
        configurationBlob: configBlob,
      },
      source: {
        eksConfiguration: {
          clusterArn: this.cluster.clusterArn,
          subnetIds: privateSubnets.map(subnet => subnet.subnetId),
        },
      },
    });

    return prometheusScraper;
  }

  private createPrometheusScraperRoleBinding(): void {
    // Create a Cluster Role Binding for the Prometheus Scraper
    const clusterRoleManifest = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'aps-collector-role' },
      rules: [
        {
          apiGroups: [''],
          resources: [
            'nodes',
            'nodes/proxy',
            'nodes/metrics',
            'services',
            'endpoints',
            'pods',
            'ingresses',
            'configmaps'
          ],
          verbs: ['describe', 'get', 'list', 'watch'],
        },
        {
          apiGroups: ['extensions', 'networking.k8s.io'],
          resources: ['ingresses/status', 'ingresses'],
          verbs: ['describe', 'get', 'list', 'watch'],
        },
        {
          nonResourceURLs: ['/metrics'],
          verbs: ['get'],
        },
      ],
    };

    // Apply the ClusterRole manifest to the EKS cluster
    this.cluster.addManifest('ApsCollectorClusterRole', clusterRoleManifest);

    // Define the ClusterRoleBinding manifest
    const clusterRoleBindingManifest = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'aps-collector-user-role-binding' },
      subjects: [
        {
          kind: 'User',
          name: 'aps-collector-user',
          apiGroup: 'rbac.authorization.k8s.io',
        },
      ],
      roleRef: {
        kind: 'ClusterRole',
        name: 'aps-collector-role',
        apiGroup: 'rbac.authorization.k8s.io',
      },
    };

    // Apply the ClusterRoleBinding manifest to the EKS cluster
    this.cluster.addManifest('ApsCollectorClusterRoleBinding', clusterRoleBindingManifest);
    
    const splitArn = cdk.Fn.split('/', this.prometheusScraper.attrRoleArn)
    const suffix = cdk.Fn.select(3, splitArn);
    const prefix = cdk.Fn.select(0, splitArn);
    const modifiedArn = `${prefix}/${suffix}`;

    // Import the IAM Role using the modified ARN
    const scraperRole = iam.Role.fromRoleArn(this, "EKSScraperRole", modifiedArn);

    // Define the username and groups
    const username = 'aps-collector-user';
    const groups = ['system:masters'];

    // Add the identity mapping to the aws-auth ConfigMap in EKS
    this.cluster.awsAuth.addRoleMapping(scraperRole, {
      username: username,
      groups: groups,
    });
  }

  private createGrafanaWorkspace(): void {
    // Create Grafana workspace Role
    const grafanaRole = new iam.Role(this, "GrafanaRole", {
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonPrometheusFullAccess'),
      ],
    });

    // Create Grafana workspace
    new grafana.CfnWorkspace(this, "GrafanaWorkspace", {
      name: "my-grafana-workspace",
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      permissionType: 'SERVICE_MANAGED',
      roleArn: grafanaRole.roleArn,
      pluginAdminEnabled: true,
    });
  }
}
