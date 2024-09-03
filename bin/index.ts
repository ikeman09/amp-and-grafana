#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AmpAndGrafanaStack } from '../lib/amp-and-grafana-stack';

const app = new cdk.App();

new AmpAndGrafanaStack(app, 'AmpAndGrafanaStack', {
  env: {
    account: '114043003553',
    region: 'us-east-1',
  },
});