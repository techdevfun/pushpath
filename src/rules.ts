/**
 * Rules: what each check looks for, how to fix it, and the 1Password
 * anchor (25/11/2026). Every fact about the incident is sourced from
 * the 1Password blog post of 25/11/2026, TechCrunch 25/11/2026, and
 * BleepingComputer 25/11/2026. Two things are deliberately NOT stated:
 * how many customers were affected (1Password said only "a subset",
 * no count) and how the GitHub account was taken over (not disclosed).
 */
export interface Rule {
  id: string;
  title: string;
  what: string;
  fix: string;
  anchor: string;
}

export const INCIDENT_SUMMARY = [
  "1Password security incident, disclosed 25/11/2026 (blog: 'Update on a security incident involving 1Password's backend systems').",
  "Investigation began 19/11/2026: an attacker had gained access to an employee's corporate GitHub account.",
  "The attacker used the account to access source code, push malicious code to backend services, and download administrative data for a subset of customers: names, email addresses, account/user identifiers, SRP parameters, and tokens in emailed invitation, provisioning, and account-recovery links.",
  "Source code was copied from private repositories and the CI/CD system was accessed.",
  "Vault contents were NOT accessed at any time. 1Password does not store account passwords or Secret Keys (zero-knowledge design).",
  "Credentials that may have been exposed were rotated or revoked. Invitation and recovery codes were lengthened from 6 numeric digits to 10 alphanumeric characters.",
  "NOT disclosed: how many customers were affected ('a subset', no count) and how the GitHub account was taken over.",
  "Invite/recovery tokens only work together with SSO or a code sent to the registered email address.",
  "Sources: 1Password blog 25/11/2026; TechCrunch 25/11/2026; BleepingComputer 25/11/2026. Verified 26/11/2026.",
];

export const RULES: Rule[] = [
  {
    id: "solo-push",
    title: "One push reaches production",
    what: "A workflow deploys to production on a push to the default branch, and no breaking control is proven in the files or from live data: no required PR review, no environment approver. One compromised account can walk alone from push to production.",
    fix: "Break the path with at least one control: (1) require pull-request review on the default branch, (2) put the deploy job behind an environment with required reviewers, or (3) deploy only on release/tag creation and protect tag and release creation. Then re-run pushpath with --live so the control is proven, not assumed.",
    anchor:
      "1Password, 25/11/2026: an attacker with one employee's GitHub account pushed malicious code to backend services and downloaded customer admin data. The push was the incident - no second credential was needed.",
  },
  {
    id: "env-approver",
    title: "Deploy job has no environment approver",
    what: "A deploy job runs with no GitHub environment, or with an environment whose required reviewers are unverified. Environments are the only deploy-time human gate GitHub offers; without one, the workflow itself is the only thing between a push and production.",
    fix: "Add an 'environment:' to the deploy job and configure required reviewers on that environment (Settings > Environments > Required reviewers). Keep the reviewer list disjoint from the people who can push.",
    anchor:
      "1Password, 25/11/2026: the malicious code reached backend services through the normal deploy path. An environment approver on that path is the control that would have forced a second human to look.",
  },
  {
    id: "pr-review",
    title: "Default branch allows unreviewed pushes",
    what: "Live branch protection does not require pull-request review on the default branch, so any account with push access can land code directly - including code a workflow then deploys.",
    fix: "Turn on branch protection for the default branch with 'Require a pull request before merging' (at least 1 approving review), block force pushes, and apply the rules to administrators too. Verify with: pushpath audit --live <repo>.",
    anchor:
      "1Password, 25/11/2026: the attacker did not need to merge anything - push access to the repo was enough to reach the deploy path. Required review is the control that makes push access insufficient on its own.",
  },
  {
    id: "least-privilege",
    title: "Workflow permissions exceed least privilege",
    what: "A workflow or job grants write scopes it does not need (for example contents: write on a test job, or permissions: write-all at the top). A compromised step inherits those scopes through GITHUB_TOKEN.",
    fix: "Set 'permissions:' at the top of each workflow to the minimum (usually contents: read, or an empty map), then add write scopes only on the jobs that need them, and only the scopes they need.",
    anchor:
      "1Password, 25/11/2026: the attacker also reached the CI/CD system. Broad workflow permissions turn a single compromised step into a wider blast radius.",
  },
  {
    id: "pin-actions",
    title: "Third-party action is not SHA-pinned",
    what: "A workflow uses a third-party action by floating tag (@v4, @main, @latest). The tag can move: the code that runs tomorrow may not be the code you reviewed today.",
    fix: "Pin every third-party action to a full 40-character commit SHA (keep the version in a trailing comment, e.g. actions/checkout@3d3c42e5... # v7.0.1). Re-pin deliberately when you upgrade.",
    anchor:
      "1Password, 25/11/2026: the attacker pushed malicious code into the build path. A floating action tag is another way the code that runs can change without a review.",
  },
  {
    id: "secret-names",
    title: "Secrets referenced by workflows",
    what: "pushpath lists the NAMES of secrets a workflow references (secrets.NAME) so reviewers can see what the deploy path can touch. It never reads, prints, or scans secret values - this is not a secret scanner.",
    fix: "Review the list: every secret a deploy job can read should be scoped to that job's environment (environment secrets, not repository secrets) and rotated on a schedule. For leaked values, use a real secret scanner (gitleaks, git-secrets).",
    anchor:
      "1Password, 25/11/2026: the CI/CD system the attacker reached holds infrastructure credentials. Knowing which secrets a deploy path can touch is the first step to scoping them.",
  },
  {
    id: "live-check",
    title: "Live data is missing (UNKNOWN, not GUARDED)",
    what: "Branch protection and environment reviewers live on the platform, not in the checkout. Without live data pushpath reports UNKNOWN for paths that depend on them - it never calls a repo GUARDED on an assumption.",
    fix: "Run 'pushpath audit --live <repo>' with the gh CLI installed and authenticated, or with a read-only GITHUB_TOKEN in the environment. The token is never printed, logged, or stored.",
    anchor:
      "1Password, 25/11/2026: the controls that matter (who can push, who must review, who approves a deploy) are platform settings, not files. Audit them live, or admit you have not.",
  },
];

export function findRule(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}
