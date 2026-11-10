import { writeNotice } from './failopen';
import { recordEvent } from './events';

/**
 * A failed agent run is surfaced as a notification with the error and a Rerun action, never as a quiet pass
 * (D-13, I-4). The VS Code extension reads notices.jsonl and shows "<Agent> did not run: <error>" with a Rerun button.
 */
export function notifyFailure(root: string, agent: string, error: string): void {
  writeNotice(root, agent, `${agent} did not run: ${error}`);
  recordEvent(root, { type: 'agent-failed', data: { agent } });
}
