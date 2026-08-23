export interface DecoyDeploymentResult {
  readonly operationKey?: string;
  readonly serviceId: string;
  readonly templateName: string;
  readonly region: string;
  readonly serviceUrl: string;
  readonly status: 'SIMULATED';
  readonly healthStatus: 'HEALTHY';
  readonly deployedAt: string;
}

export interface FalseRouteResult {
  readonly operationKey?: string;
  readonly routeId: string;
  readonly sourceIp: string;
  readonly assignedTarget: string;
  readonly status: 'SIMULATED';
  readonly assignedAt: string;
}

export interface CloudArmorQuarantineResult {
  readonly operationKey?: string;
  readonly ruleId: string;
  readonly policyName: string;
  readonly sourceCidr: string;
  readonly rulePriority: number;
  readonly status: 'SIMULATED';
  readonly enforcedAt: string;
}

export class FakeCloudRunAdapter {
  private deployedServices = new Map<string, DecoyDeploymentResult>();
  private deploymentsByOperation = new Map<string, DecoyDeploymentResult>();
  private deploymentSequence = 0;
  public deployCount = 0;
  public deleteCount = 0;

  async deployDecoy(params: {
    templateName: string;
    region: string;
    ttlSeconds: number;
    operationKey?: string;
  }): Promise<DecoyDeploymentResult> {
    this.deployCount++;
    this.deploymentSequence++;
    const serviceId = `cr-${params.templateName}-${Date.now().toString(36)}-${this.deploymentSequence}`;
    const serviceUrl = `https://${serviceId}-${params.region}.run.app.dummy`;

    const result: DecoyDeploymentResult = {
      ...(params.operationKey && { operationKey: params.operationKey }),
      serviceId,
      templateName: params.templateName,
      region: params.region,
      serviceUrl,
      status: 'SIMULATED',
      healthStatus: 'HEALTHY',
      deployedAt: new Date().toISOString(),
    };

    this.deployedServices.set(params.templateName, result);
    this.deployedServices.set(serviceId, result);
    if (params.operationKey) this.deploymentsByOperation.set(params.operationKey, result);
    return result;
  }

  getDecoy(serviceIdOrTemplate: string): DecoyDeploymentResult | undefined {
    return this.deployedServices.get(serviceIdOrTemplate);
  }

  /** Recovery lookup fenced to the exact provider operation, never a shared template name. */
  getDecoyByOperation(operationKey: string): DecoyDeploymentResult | undefined {
    const result = this.deploymentsByOperation.get(operationKey);
    return result && this.deployedServices.get(result.serviceId)?.serviceId === result.serviceId
      ? result
      : undefined;
  }

  /** Deletes only the decoy still owned by this exact operation. */
  async deleteDecoyByOperation(
    operationKey: string,
  ): Promise<{ deleted: boolean; status: 'SIMULATED' }> {
    const exact = this.getDecoyByOperation(operationKey);
    return exact ? this.deleteDecoy(exact.serviceId) : { deleted: false, status: 'SIMULATED' };
  }

  listDecoys(): readonly DecoyDeploymentResult[] {
    const unique = new Map<string, DecoyDeploymentResult>();
    for (const item of this.deployedServices.values()) {
      unique.set(item.serviceId, item);
    }
    return Array.from(unique.values());
  }

  async deleteDecoy(
    serviceIdOrTemplate: string,
  ): Promise<{ deleted: boolean; status: 'SIMULATED' }> {
    this.deleteCount++;
    const existing = this.deployedServices.get(serviceIdOrTemplate);
    if (existing) {
      if (this.deployedServices.get(existing.templateName)?.serviceId === existing.serviceId) {
        this.deployedServices.delete(existing.templateName);
      }
      this.deployedServices.delete(existing.serviceId);
      for (const [operationKey, result] of this.deploymentsByOperation) {
        if (result.serviceId === existing.serviceId)
          this.deploymentsByOperation.delete(operationKey);
      }
      return { deleted: true, status: 'SIMULATED' };
    }
    return { deleted: false, status: 'SIMULATED' };
  }

  clear(): void {
    this.deployedServices.clear();
    this.deploymentsByOperation.clear();
    this.deployCount = 0;
    this.deploymentSequence = 0;
    this.deleteCount = 0;
  }
}

export class FakeFalseRouteAdapter {
  private activeRoutes = new Map<string, FalseRouteResult>();
  private routesByOperation = new Map<string, FalseRouteResult>();
  private routeSequence = 0;
  public assignCount = 0;
  public revokeCount = 0;

  async assignRoute(params: {
    sourceIp: string;
    targetService: string;
    operationKey?: string;
  }): Promise<FalseRouteResult> {
    this.assignCount++;
    this.routeSequence++;
    const routeId = `fr-route-${Date.now().toString(36)}-${this.routeSequence}`;
    const result: FalseRouteResult = {
      ...(params.operationKey && { operationKey: params.operationKey }),
      routeId,
      sourceIp: params.sourceIp,
      assignedTarget: params.targetService,
      status: 'SIMULATED',
      assignedAt: new Date().toISOString(),
    };

    this.activeRoutes.set(params.sourceIp, result);
    if (params.operationKey) this.routesByOperation.set(params.operationKey, result);
    return result;
  }

  getRoute(sourceIp: string): FalseRouteResult | undefined {
    return this.activeRoutes.get(sourceIp);
  }

  /** Recovery lookup succeeds only while this operation's exact route is still active. */
  getRouteByOperation(operationKey: string): FalseRouteResult | undefined {
    const result = this.routesByOperation.get(operationKey);
    return result && this.activeRoutes.get(result.sourceIp)?.routeId === result.routeId
      ? result
      : undefined;
  }

  /** Revokes only when this operation's exact route is still the active route for its source. */
  async revokeRouteByOperation(
    operationKey: string,
  ): Promise<{ revoked: boolean; status: 'SIMULATED' }> {
    const exact = this.getRouteByOperation(operationKey);
    return exact ? this.revokeRoute(exact.sourceIp) : { revoked: false, status: 'SIMULATED' };
  }

  listRoutes(): readonly FalseRouteResult[] {
    return Array.from(this.activeRoutes.values());
  }

  /** Observation boundary: reports whether the simulated inventory still holds this route. */
  async hasActiveRoute(sourceIp: string): Promise<boolean> {
    return this.activeRoutes.has(sourceIp);
  }

  async revokeRoute(sourceIp: string): Promise<{ revoked: boolean; status: 'SIMULATED' }> {
    this.revokeCount++;
    const existing = this.activeRoutes.get(sourceIp);
    const existed = this.activeRoutes.delete(sourceIp);
    if (existing) {
      for (const [operationKey, result] of this.routesByOperation) {
        if (result.routeId === existing.routeId) this.routesByOperation.delete(operationKey);
      }
    }
    return { revoked: existed, status: 'SIMULATED' };
  }

  clear(): void {
    this.activeRoutes.clear();
    this.routesByOperation.clear();
    this.assignCount = 0;
    this.routeSequence = 0;
    this.revokeCount = 0;
  }
}

export class FakeCloudArmorAdapter {
  private activeQuarantines = new Map<string, CloudArmorQuarantineResult>();
  private quarantinesByOperation = new Map<string, CloudArmorQuarantineResult>();
  private quarantineSequence = 0;
  private allocatedPriority = 1050;
  public applyCount = 0;
  public releaseCount = 0;

  async applyQuarantine(params: {
    sourceCidr: string;
    policyName?: string;
    operationKey?: string;
  }): Promise<CloudArmorQuarantineResult> {
    this.applyCount++;
    this.quarantineSequence++;
    const rulePriority = this.allocatedPriority;
    this.allocatedPriority += 1;

    const result: CloudArmorQuarantineResult = {
      ...(params.operationKey && { operationKey: params.operationKey }),
      ruleId: `ca-rule-${Date.now().toString(36)}-${this.quarantineSequence}`,
      policyName: params.policyName ?? 'falseroute-quarantine-policy',
      sourceCidr: params.sourceCidr,
      rulePriority,
      status: 'SIMULATED',
      enforcedAt: new Date().toISOString(),
    };

    this.activeQuarantines.set(params.sourceCidr, result);
    if (params.operationKey) this.quarantinesByOperation.set(params.operationKey, result);
    return result;
  }

  getQuarantine(sourceCidr: string): CloudArmorQuarantineResult | undefined {
    return this.activeQuarantines.get(sourceCidr);
  }

  /** Recovery lookup succeeds only while this operation's exact rule is still active. */
  getQuarantineByOperation(operationKey: string): CloudArmorQuarantineResult | undefined {
    const result = this.quarantinesByOperation.get(operationKey);
    return result && this.activeQuarantines.get(result.sourceCidr)?.ruleId === result.ruleId
      ? result
      : undefined;
  }

  /** Releases only when this operation's exact quarantine is still active for its CIDR. */
  async releaseQuarantineByOperation(
    operationKey: string,
  ): Promise<{ released: boolean; status: 'SIMULATED' }> {
    const exact = this.getQuarantineByOperation(operationKey);
    return exact
      ? this.releaseQuarantine(exact.sourceCidr)
      : { released: false, status: 'SIMULATED' };
  }

  listQuarantines(): readonly CloudArmorQuarantineResult[] {
    return Array.from(this.activeQuarantines.values());
  }

  /** Observation boundary: reports whether the simulated inventory still holds this quarantine. */
  async hasActiveQuarantine(sourceCidr: string): Promise<boolean> {
    return this.activeQuarantines.has(sourceCidr);
  }

  async releaseQuarantine(sourceCidr: string): Promise<{ released: boolean; status: 'SIMULATED' }> {
    this.releaseCount++;
    const existing = this.activeQuarantines.get(sourceCidr);
    const existed = this.activeQuarantines.delete(sourceCidr);
    if (existing) {
      for (const [operationKey, result] of this.quarantinesByOperation) {
        if (result.ruleId === existing.ruleId) this.quarantinesByOperation.delete(operationKey);
      }
    }
    return { released: existed, status: 'SIMULATED' };
  }

  clear(): void {
    this.activeQuarantines.clear();
    this.quarantinesByOperation.clear();
    this.allocatedPriority = 1050;
    this.applyCount = 0;
    this.quarantineSequence = 0;
    this.releaseCount = 0;
  }
}
