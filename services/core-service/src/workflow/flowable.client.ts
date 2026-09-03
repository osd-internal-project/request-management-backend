import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';

export interface DeployedProcess {
  readonly deploymentId: string;
  readonly processDefinitionId: string;
}

export interface OpenTask {
  readonly id: string;
  /** The BPMN element id — which is our `WorkflowState.key`. */
  readonly taskDefinitionKey: string;
}

/**
 * The only thing in this codebase that talks to Flowable.
 *
 * Modelled on `principal/approval-context.client.ts` down to the shape of the
 * error handling, and for the same reasons: `fetch` directly rather than a
 * client library, failures turned into `AppError` with a Thai message the UI
 * can show, and **no caching** — a cached "which task is open" is a screen
 * offering a button the engine has already moved past.
 *
 * Flowable is told nothing about the domain. It holds the route, the process
 * variables it was handed, and nothing else: no business data, no identities,
 * and no say in who may press what. Authorisation stays with `PolicyGuard` and
 * `hasAuthority` (ROLE-01), which is why none of these calls pass a user.
 */
@Injectable()
export class FlowableClient {
  private readonly logger = new Logger(FlowableClient.name);

  constructor(private readonly config: ConfigService) {}

  private get base(): string {
    return (
      this.config.get<string>('flowable.baseUrl') ??
      'http://localhost:8080/flowable-rest/service'
    );
  }

  private get authorization(): string {
    const user = this.config.get<string>('flowable.user') ?? '';
    const password = this.config.get<string>('flowable.password') ?? '';

    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  /** Whether the engine is answering — for `/health`, which must not lie. */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.base}/repository/deployments?size=1`,
        {
          headers: { Authorization: this.authorization },
        },
      );

      return response.ok;
    } catch {
      return false;
    }
  }

  /** Deploys generated BPMN. Called once, at publish. */
  async deploy(name: string, bpmnXml: string): Promise<DeployedProcess> {
    const form = new FormData();
    form.append(
      'deployment',
      new Blob([bpmnXml], { type: 'text/xml' }),
      `${name}.bpmn20.xml`,
    );

    const body = await this.send<{
      id: string;
      // Flowable answers with the deployment; the definition is read back
      // separately because a deployment may carry several.
    }>('POST', '/repository/deployments', form);

    const definitions = await this.send<{
      data: { id: string }[];
    }>(
      'GET',
      `/repository/process-definitions?deploymentId=${encodeURIComponent(body.id)}`,
    );

    const definitionId = definitions.data[0]?.id;
    if (!definitionId) {
      throw new AppError(
        'WORKFLOW_UNAVAILABLE',
        'เผยแพร่ผังงานไปที่ระบบ workflow แล้วแต่ไม่พบ process ที่ deploy',
      );
    }

    return { deploymentId: body.id, processDefinitionId: definitionId };
  }

  /** Starts an instance for one request. */
  async startProcess(
    processKey: string,
    businessKey: string,
    variables: Record<string, unknown>,
  ): Promise<string> {
    const body = await this.send<{ id: string }>(
      'POST',
      '/runtime/process-instances',
      {
        processDefinitionKey: processKey,
        businessKey,
        variables: toFlowableVariables(variables),
      },
    );

    return body.id;
  }

  /** The task an instance is currently waiting on, if any. */
  async openTask(processInstanceId: string): Promise<OpenTask | null> {
    const body = await this.send<{ data: OpenTask[] }>(
      'GET',
      `/runtime/tasks?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    );

    return body.data[0] ?? null;
  }

  /**
   * Presses a button.
   *
   * `action` is what the generated gateway branches on, so it always travels
   * even when the action asks for no other data.
   */
  async completeTask(
    taskId: string,
    action: string,
    variables: Record<string, unknown>,
  ): Promise<void> {
    await this.send('POST', `/runtime/tasks/${encodeURIComponent(taskId)}`, {
      action: 'complete',
      variables: toFlowableVariables({ ...variables, action }),
    });
  }

  private async send<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const isForm = body instanceof FormData;

    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.authorization,
          ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        },
        body: isForm ? body : body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      this.logger.error(
        `flowable unreachable: ${method} ${path} — ${error instanceof Error ? error.message : ''}`,
      );
      throw new AppError(
        'WORKFLOW_UNAVAILABLE',
        'ติดต่อระบบ workflow ไม่ได้ กรุณาลองใหม่อีกครั้ง',
      );
    }

    if (!response.ok) {
      this.logger.warn(
        `flowable answered HTTP ${response.status}: ${method} ${path}`,
      );
      throw new AppError(
        'WORKFLOW_UNAVAILABLE',
        'ระบบ workflow ปฏิเสธคำสั่ง กรุณาติดต่อผู้ดูแลระบบ',
        [{ field: 'flowable', reason: `HTTP ${response.status}` }],
      );
    }

    // 204 on completeTask — there is no body to parse.
    if (response.status === 204) return undefined as T;

    return (await response.json()) as T;
  }
}

/**
 * Flowable wants `[{ name, value }]`, not an object.
 *
 * Kept here rather than at each call site so the engine's wire format stops at
 * this file — everything above it passes a plain object.
 */
function toFlowableVariables(
  variables: Record<string, unknown>,
): { name: string; value: unknown }[] {
  return Object.entries(variables).map(([name, value]) => ({ name, value }));
}
