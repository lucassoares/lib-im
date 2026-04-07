import { writeFileSync } from "fs";

const GITHUB_ORG = process.env.GITHUB_ORG;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITLAB_GROUP = process.env.GITLAB_GROUP;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

if (!GITHUB_ORG || !GITHUB_TOKEN || !GITLAB_GROUP || !GITLAB_TOKEN) {
  console.error("Required: GITHUB_ORG, GITHUB_TOKEN, GITLAB_GROUP, GITLAB_TOKEN");
  process.exit(1);
}

const REPOS = [
  "lib-foo",
  "lib-bar",
  "lib-baz",
];

const githubHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const gitlabHeaders = {
  "PRIVATE-TOKEN": GITLAB_TOKEN,
};

async function fetchGithubPackage(packageName) {
  const res = await fetch(
    `https://api.github.com/orgs/${GITHUB_ORG}/packages/nuget/${packageName}`,
    { headers: githubHeaders }
  );

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub package fetch failed for ${packageName}: ${res.status} ${res.statusText}`);

  return res.json();
}

async function fetchPackageVersions(packageName) {
  const versions = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.github.com/orgs/${GITHUB_ORG}/packages/nuget/${packageName}/versions?per_page=100&page=${page}`,
      { headers: githubHeaders }
    );

    if (!res.ok) throw new Error(`GitHub versions fetch failed for ${packageName}: ${res.status}`);

    const data = await res.json();
    if (data.length === 0) break;

    versions.push(...data);
    page++;
  }

  return versions;
}

async function fetchGitlabProjectId(repoName) {
  const encoded = encodeURIComponent(`${GITLAB_GROUP}/${repoName}`);
  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${encoded}`,
    { headers: gitlabHeaders }
  );

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitLab project fetch failed for ${repoName}: ${res.status}`);

  const data = await res.json();
  return data.id;
}

function isStableVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version) && !version.includes("-beta");
}

async function main() {
  console.log(`Processing ${REPOS.length} repos`);

  const configBlocks = [];
  const notFound = [];

  for (const repoName of REPOS) {
    const pkg = await fetchGithubPackage(repoName);

    if (!pkg) {
      console.warn(`GitHub package not found for: ${repoName}`);
      notFound.push(repoName);
      continue;
    }

    const projectId = await fetchGitlabProjectId(repoName);

    if (!projectId) {
      console.warn(`GitLab project not found for: ${repoName}`);
      notFound.push(repoName);
      continue;
    }

    const allVersions = await fetchPackageVersions(repoName);
    const stable = allVersions
      .map((v) => v.name)
      .filter(isStableVersion)
      .slice(0, 10);

    if (stable.length === 0) {
      console.warn(`No stable versions found for: ${repoName}`);
      continue;
    }

    const csvFileName = `${repoName}.csv`;
    writeFileSync(csvFileName, stable.map((v) => `${repoName},${v}`).join("\n"));

    const blockKey = repoName.replace(/-/g, "_");
    const block = [
      `${blockKey}:`,
      `  type: nuget`,
      `  source:`,
      `    url: https://nuget.pkg.github.com/${GITHUB_ORG}/index.json`,
      `    credentials:`,
      `      username: $GITHUB_USERNAME`,
      `      token: $GITHUB_TOKEN`,
      `  destination:`,
      `    url: https://gitlab.com/api/v4/projects/${projectId}/packages/nuget/index.json`,
      `    credentials:`,
      `      username: $GITLAB_USERNAME`,
      `      token: $GITLAB_TOKEN`,
      `  packages: "${csvFileName}"`,
    ].join("\n");

    configBlocks.push(block);
    console.log(`${repoName} -> project ${projectId} (${stable.length} versions)`);
  }

  writeFileSync("config.yml", configBlocks.join("\n\n"));
  console.log(`\nconfig.yml generated with ${configBlocks.length} blocks`);

  if (notFound.length > 0) {
    writeFileSync("not-found.txt", notFound.join("\n"));
    console.warn(`not-found.txt generated with ${notFound.length} entries`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
