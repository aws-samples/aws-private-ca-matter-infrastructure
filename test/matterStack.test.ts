/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {MatterStack} from "../lib/matterStacks";

function common(app: App, genPaiCnt: string | undefined) {
  const stack = new MatterStack(app, 'MyTestStack', "", genPaiCnt);
  return Template.fromStack(stack);
}

test('Create PAA', () => {
  // WHEN
  const app = new cdk.App({context: {}});
  app.node.setContext('generatePaa', '');
  const template = common(app, undefined);

  // THEN
  template.resourceCountIs('AWS::ACMPCA::CertificateAuthority', 1);
  template.resourceCountIs('AWS::ACMPCA::Certificate', 1);
  template.resourceCountIs('AWS::ACMPCA::CertificateAuthorityActivation', 1);
});

test('Create single PAI', () => {
  // WHEN
  let app = new cdk.App();

  let template = common(app, '1');

  // THEN
  template.resourceCountIs('AWS::ACMPCA::CertificateAuthority', 1);
  template.resourceCountIs('AWS::ACMPCA::Certificate', 0);
  template.resourceCountIs('AWS::ACMPCA::CertificateAuthorityActivation', 1);
});

test('Create multiple PAI', () => {
  // WHEN
  const app = new cdk.App();
  const template = common(app, '5');

  // THEN
  template.resourceCountIs('AWS::ACMPCA::CertificateAuthority', 5);
  template.resourceCountIs('AWS::ACMPCA::Certificate', 0);
  template.resourceCountIs('AWS::ACMPCA::CertificateAuthorityActivation', 5);
});



