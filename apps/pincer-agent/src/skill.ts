import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function skillDir(): string {
  return path.join(os.homedir(), ".openclaw", "skills", "pincer");
}

function buildSkillContent(workerUrl: string): string {
  return `# Pincer - Secure Adapter Boundary

Pincer routes external API calls through a Cloudflare Worker boundary. Secrets stay on the Worker.

## Worker

Connected to: ${workerUrl}

## Runtime Calls

Call installed adapters:

\`\`\`bash
pincer-agent call <adapter_id> <action_name> --input '{"key":"value"}'
\`\`\`

## Proposing New Adapters

Submit a proposal manifest for admin review:

\`\`\`bash
pincer-agent adapters propose --file ./manifest.json
# or
pincer-agent adapters propose --manifest '{"id":"...","revision":1,...}'
\`\`\`

## Admin Workflow

A proposal is not active until an admin applies it:

\`\`\`bash
pincer-admin proposals list
pincer-admin proposals inspect <proposal_id>
pincer-admin proposals approve <proposal_id>
pincer-admin proposals reject <proposal_id> --reason "..."
\`\`\`

Admins can also apply directly from file/URL:

\`\`\`bash
pincer-admin adapters apply --file ./manifest.json
pincer-admin adapters apply --url https://example.com/manifest.json
\`\`\`

Validate a manifest before submitting:

\`\`\`bash
pincer-agent adapters validate --file ./manifest.json
\`\`\`

## Updating An Adapter

To update an existing adapter, submit/apply a new manifest with:
- the same \`id\`
- a higher \`revision\`

For API key rotation, admins can update secrets without changing manifests:

\`\`\`bash
pincer-admin adapters secret set <SECRET_BINDING>
\`\`\`

## Visibility

Check active adapters and status:

\`\`\`bash
pincer-agent adapters list
pincer-admin adapters list
\`\`\`
`;
}

export function installSkill(workerUrl: string): string {
  const dir = skillDir();
  const filePath = path.join(dir, "SKILL.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buildSkillContent(workerUrl));
  return filePath;
}
