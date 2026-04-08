import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";

const GITHUB_ORG = process.env.GITHUB_ORG;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITLAB_GROUP = process.env.GITLAB_GROUP;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

if (!GITHUB_ORG || !GITHUB_TOKEN || !GITHUB_USERNAME || !GITLAB_GROUP || !GITLAB_TOKEN) {
  console.error("Required: GITHUB_ORG, GITHUB_TOKEN, GITHUB_USERNAME, GITLAB_GROUP, GITLAB_TOKEN");
  process.exit(1);
}

const REPOS = [
  "lib-foo",
  "lib-bar",
  "lib-baz",
];

const TMP_DIR = "./tmp_nupkgs";

const githubHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
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
    { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitLab project fetch failed for ${repoName}: ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function downloadNupkg(packageName, version, destPath) {
  const pkgLower = packageName.toLowerCase();
  const verLower = version.toLowerCase();
  const fileName = `${pkgLower}.${verLower}.nupkg`;
  const url = `https://nuget.pkg.github.com/${GITHUB_ORG}/download/${pkgLower}/${verLower}/${fileName}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${GITHUB_USERNAME}:${GITHUB_TOKEN}`).toString("base64")}`,
    },
  });

  if (!res.ok) throw new Error(`Download failed for ${packageName} ${version}: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buffer);
}

async function uploadToGitlab(projectId, nupkgPath) {
  const fileBuffer = readFileSync(nupkgPath);
  const fileName = nupkgPath.split("/").pop();

  const formData = new FormData();
  formData.append("package", new Blob([fileBuffer], { type: "application/octet-stream" }), fileName);

  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${projectId}/packages/nuget/v2`,
    {
      method: "PUT",
      headers: { "X-NuGet-ApiKey": GITLAB_TOKEN },
      body: formData,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab upload failed for ${fileName}: ${res.status} - ${text}`);
  }
}

function isStable(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function isBeta(version) {
  return /^\d+\.\d+\.\d+-beta$/.test(version);
}

async function main() {
  console.log(`Processing ${REPOS.length} repos\n`);

  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR);

  const notFound = [];
  const failed = [];

  for (const repoName of REPOS) {
    console.log(`==> ${repoName}`);

    const pkg = await fetchGithubPackage(repoName);
    if (!pkg) {
      console.warn(`  GitHub package not found, skipping`);
      notFound.push(repoName);
      continue;
    }

    const projectId = await fetchGitlabProjectId(repoName);
    if (!projectId) {
      console.warn(`  GitLab project not found, skipping`);
      notFound.push(repoName);
      continue;
    }

    const allVersions = await fetchPackageVersions(repoName);
    const names = allVersions.map((v) => v.name);
    const selected = [
      ...names.filter(isStable).slice(0, 10),
      ...names.filter(isBeta).slice(0, 10),
    ];

    if (selected.length === 0) {
      console.warn(`  No versions found, skipping`);
      continue;
    }

    console.log(`  GitLab project: ${projectId}`);
    console.log(`  Versions to migrate: ${selected.join(", ")}\n`);

    for (const version of selected) {
      const fileName = `${repoName.toLowerCase()}.${version.toLowerCase()}.nupkg`;
      const tmpPath = `${TMP_DIR}/${fileName}`;

      try {
        process.stdout.write(`  [${version}] Downloading...`);
        await downloadNupkg(repoName, version, tmpPath);
        process.stdout.write(` Uploading to GitLab...`);
        await uploadToGitlab(projectId, tmpPath);
        process.stdout.write(` Done\n`);
      } catch (err) {
        process.stdout.write(` FAILED\n`);
        console.error(`    ${err.message}`);
        failed.push(`${repoName}@${version}`);
      }
    }
  }

  rmSync(TMP_DIR, { recursive: true });

  console.log(`\nMigration complete`);

  if (notFound.length > 0) {
    writeFileSync("not-found.txt", notFound.join("\n"));
    console.log(`not-found.txt: ${notFound.length} repos not found`);
  }

  if (failed.length > 0) {
    writeFileSync("failed.txt", failed.join("\n"));
    console.log(`failed.txt: ${failed.length} packages failed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
