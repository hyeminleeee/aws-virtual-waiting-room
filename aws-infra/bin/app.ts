#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { KtxWaitingRoomStack } from '../lib/ktx-waiting-room-stack';

const app = new cdk.App();
new KtxWaitingRoomStack(app, 'KtxWaitingRoomStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-2',
  },
});
