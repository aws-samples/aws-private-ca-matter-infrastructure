/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import {App} from "aws-cdk-lib";
import {MatterStack} from "../lib/matterStacks";

const app = new App();

const stackNamePrefix = app.node.tryGetContext('stackNamePrefix') ?? ""
const genPaiCnt = app.node.tryGetContext('generatePaiCnt');
new MatterStack(app, stackNamePrefix + 'MatterStack' + (genPaiCnt ? "PAI" : "PAA"), stackNamePrefix, genPaiCnt);
