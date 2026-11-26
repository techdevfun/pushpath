/**
 * Deploy detection data: known deploy actions and deploy commands.
 *
 * This is a heuristic list, not a proof of deployment. A job is a
 * deploy job when its id/name says deploy/publish/release, or a step
 * uses a known deploy action, or a run step runs a known deploy
 * command. Steps that match nothing are never silently treated as
 * safe - remote-affecting run steps inside a deploy job are flagged
 * separately by the scanner.
 */

export interface DeployActionRule {
  /** Lowercase substring matched against the action path (before @ref). */
  substr: string;
  target: string;
  label: string;
}

export const DEPLOY_ACTIONS: DeployActionRule[] = [
  {
    substr: "actions/deploy-pages",
    target: "GitHub Pages",
    label: "GitHub Pages deploy action",
  },
  {
    substr: "peaceiris/actions-gh-pages",
    target: "GitHub Pages",
    label: "gh-pages deploy action",
  },
  {
    substr: "jamesives/github-pages-deploy-action",
    target: "GitHub Pages",
    label: "gh-pages deploy action",
  },
  {
    substr: "crazy-max/ghaction-github-pages",
    target: "GitHub Pages",
    label: "gh-pages deploy action",
  },
  {
    substr: "goreleaser/goreleaser-action",
    target: "GitHub release",
    label: "GoReleaser release action",
  },
  {
    substr: "softprops/action-gh-release",
    target: "GitHub release",
    label: "GitHub release action",
  },
  {
    substr: "ncipollo/release-action",
    target: "GitHub release",
    label: "GitHub release action",
  },
  {
    substr: "google-github-actions/deploy-cloudrun",
    target: "Google Cloud Run",
    label: "Cloud Run deploy action",
  },
  {
    substr: "google-github-actions/deploy-appengine",
    target: "Google App Engine",
    label: "App Engine deploy action",
  },
  {
    substr: "google-github-actions/deploy-cloud-functions",
    target: "Google Cloud Functions",
    label: "Cloud Functions deploy action",
  },
  {
    substr: "azure/webapps-deploy",
    target: "Azure Web App",
    label: "Azure deploy action",
  },
  {
    substr: "azure/aci-deploy",
    target: "Azure Container Instances",
    label: "Azure deploy action",
  },
  {
    substr: "azure/functions-action",
    target: "Azure Functions",
    label: "Azure deploy action",
  },
  {
    substr: "azure/static-web-apps-deploy",
    target: "Azure Static Web Apps",
    label: "Azure deploy action",
  },
  {
    substr: "amondnet/vercel-action",
    target: "Vercel",
    label: "Vercel deploy action",
  },
  {
    substr: "netlify/actions/cli",
    target: "Netlify",
    label: "Netlify deploy action",
  },
  {
    substr: "docker/build-push-action",
    target: "container registry",
    label: "Docker build-and-push action",
  },
  {
    substr: "docker/build-push",
    target: "container registry",
    label: "Docker build-and-push action",
  },
  {
    substr: "redhat-actions/oc-login",
    target: "OpenShift",
    label: "OpenShift login (deploy-adjacent)",
  },
  {
    substr: "hashicorp/setup-terraform",
    target: "infrastructure",
    label: "Terraform setup (deploy-adjacent)",
  },
];

export interface DeployCommandRule {
  re: RegExp;
  target: string;
  label: string;
}

export const DEPLOY_COMMANDS: DeployCommandRule[] = [
  { re: /\bnpm publish\b/, target: "npm registry", label: "npm publish" },
  {
    re: /\b(pnpm|yarn) publish\b/,
    target: "npm registry",
    label: "package publish",
  },
  { re: /\btwine upload\b/, target: "PyPI", label: "twine upload" },
  { re: /\bcargo publish\b/, target: "crates.io", label: "cargo publish" },
  {
    re: /\b(docker|podman) push\b/,
    target: "container registry",
    label: "image push",
  },
  {
    re: /\bgh release (create|upload)\b/,
    target: "GitHub release",
    label: "gh release",
  },
  { re: /\bhub release\b/, target: "GitHub release", label: "hub release" },
  {
    re: /\bsemantic-release\b/,
    target: "GitHub release",
    label: "semantic-release",
  },
  {
    re: /\bkubectl (apply|create|rollout|set image)\b/,
    target: "Kubernetes",
    label: "kubectl deploy",
  },
  {
    re: /\bhelm (upgrade --install|install|upgrade)\b/,
    target: "Kubernetes",
    label: "helm deploy",
  },
  {
    re: /\bterraform apply\b/,
    target: "infrastructure",
    label: "terraform apply",
  },
  { re: /\bpulumi up\b/, target: "infrastructure", label: "pulumi up" },
  {
    re: /\b(cdktf|cdktf) deploy\b/,
    target: "infrastructure",
    label: "cdktf deploy",
  },
  {
    re: /\bserverless deploy\b/,
    target: "Serverless",
    label: "serverless deploy",
  },
  { re: /\bsls deploy\b/, target: "Serverless", label: "serverless deploy" },
  { re: /\bfirebase deploy\b/, target: "Firebase", label: "firebase deploy" },
  {
    re: /\bgcloud (app deploy|run deploy|functions deploy)\b/,
    target: "Google Cloud",
    label: "gcloud deploy",
  },
  { re: /\baws s3 sync\b/, target: "AWS S3", label: "aws s3 sync" },
  {
    re: /\baz (webapp|functionapp).*deploy/,
    target: "Azure",
    label: "az deploy",
  },
  { re: /\b(flyctl|fly) deploy\b/, target: "Fly.io", label: "fly deploy" },
  {
    re: /\bvercel (--prod|deploy)\b/,
    target: "Vercel",
    label: "vercel deploy",
  },
  { re: /\bnetlify deploy\b/, target: "Netlify", label: "netlify deploy" },
  {
    re: /\bwrangler (publish|deploy)\b/,
    target: "Cloudflare",
    label: "wrangler publish",
  },
  { re: /\bgit push heroku\b/, target: "Heroku", label: "git push heroku" },
  {
    re: /\b(npm|yarn|pnpm) run deploy\b/,
    target: "project deploy script",
    label: "deploy script",
  },
  {
    re: /\bko (publish|apply)\b/,
    target: "container registry",
    label: "ko publish",
  },
  {
    re: /\bcosign sign\b/,
    target: "container registry",
    label: "cosign sign (release signing)",
  },
];

/** Remote-affecting verbs in a run step that deserve a second look. */
export const REMOTE_STEP_RE =
  /\b(curl|wget|scp|rsync|ssh|git push|gh |aws |az |gcloud|kubectl|helm|terraform|pulumi)\b/;

const JOB_NAME_RE = /deploy|publish|release|ship|rollout/i;

/** Infer a production target from a job id/name when no step names one. */
export function inferTargetFromName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.includes("page")) return "GitHub Pages";
  if (lower.includes("npm") || lower.includes("package")) return "npm registry";
  if (
    lower.includes("docker") ||
    lower.includes("image") ||
    lower.includes("container")
  )
    return "container registry";
  if (lower.includes("release")) return "GitHub release";
  if (
    lower.includes("deploy") ||
    lower.includes("publish") ||
    lower.includes("ship")
  )
    return "production (unspecified)";
  return null;
}

export function jobNameLooksDeploy(
  jobId: string,
  jobName: string | undefined,
): boolean {
  return (
    JOB_NAME_RE.test(jobId) ||
    (jobName !== undefined && JOB_NAME_RE.test(jobName))
  );
}

/** True when the ref after @ is a 40-char hex SHA (pinned). */
export function isShaPinned(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

export function splitUses(value: string): { path: string; ref: string } | null {
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  return { path: value.slice(0, at), ref: value.slice(at + 1) };
}
