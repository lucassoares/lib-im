import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const CONFIG = {
  GITHUB_ORG: "sua-org",
  GITHUB_USERNAME: "seu-usuario-github",
  GITHUB_TOKEN: "ghp_...",

  GITLAB_HOST: "gitlab.com",
  GITLAB_GROUP: "empresa/projects/engenharia/arquitetura",
  GITLAB_GROUP_ID: "123456",
  GITLAB_TOKEN: "glpat-...",

  BRANCH_NAME: "chore/migrate-to-gitlab",
};

const REPOS = [
  "lib-foo",
  "lib-bar",
  "lib-baz",
];

const GITHUB_NUGET_URL = `https://nuget.pkg.github.com/${CONFIG.GITHUB_ORG}/index.json`;
const GITLAB_NUGET_URL = `https://${CONFIG.GITLAB_HOST}/api/v4/groups/${CONFIG.GITLAB_GROUP_ID}/-/packages/nuget/index.json`;

const GITLAB_CI_CONTENT = `# TODO: substituir pelo conteudo real
include:
  - project: 'empresa/projects/engenharia/arquitetura/reusable-pipelines'
    file: '/templates/.gitlab-ci.yml'
`;

const TMP_DIR = "./tmp_nupkgs";
const MIRROR_DIR = "./tmp_mirrors";
const CLONE_DIR = "./tmp_clones";

const githubHeaders = {
  Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

function exec(cmd, options = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...options });
}

async function fetchGithubPackage(packageName) {
  const res = await fetch(
    `https://api.github.com/orgs/${CONFIG.GITHUB_ORG}/packages/nuget/${packageName}`,
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
      `https://api.github.com/orgs/${CONFIG.GITHUB_ORG}/packages/nuget/${packageName}/versions?per_page=100&page=${page}`,
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
  const encoded = encodeURIComponent(`${CONFIG.GITLAB_GROUP}/${repoName}`);
  const res = await fetch(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${encoded}`,
    { headers: { "PRIVATE-TOKEN": CONFIG.GITLAB_TOKEN } }
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
  const url = `https://nuget.pkg.github.com/${CONFIG.GITHUB_ORG}/download/${pkgLower}/${verLower}/${fileName}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${CONFIG.GITHUB_USERNAME}:${CONFIG.GITHUB_TOKEN}`).toString("base64")}`,
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
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/packages/nuget/v2`,
    {
      method: "PUT",
      headers: { "X-NuGet-ApiKey": CONFIG.GITLAB_TOKEN },
      body: formData,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab upload failed for ${fileName}: ${res.status} - ${text}`);
  }
}

function mirrorRepo(repoName) {
  const mirrorPath = `${MIRROR_DIR}\\${repoName}.git`;
  const githubUrl = `https://${CONFIG.GITHUB_USERNAME}:${CONFIG.GITHUB_TOKEN}@github.com/${CONFIG.GITHUB_ORG}/${repoName}.git`;
  const gitlabUrl = `https://oauth2:${CONFIG.GITLAB_TOKEN}@${CONFIG.GITLAB_HOST}/${CONFIG.GITLAB_GROUP}/${repoName}.git`;

  if (existsSync(mirrorPath)) rmSync(mirrorPath, { recursive: true });

  exec(`git clone --mirror ${githubUrl} "${mirrorPath}"`);
  exec(`git -C "${mirrorPath}" remote set-url --push origin ${gitlabUrl}`);
  exec(`git -C "${mirrorPath}" push --mirror`);

  rmSync(mirrorPath, { recursive: true });
}

function adjustRepo(repoName) {
  const clonePath = `${CLONE_DIR}\\${repoName}`;
  const gitlabUrl = `https://oauth2:${CONFIG.GITLAB_TOKEN}@${CONFIG.GITLAB_HOST}/${CONFIG.GITLAB_GROUP}/${repoName}.git`;

  if (existsSync(clonePath)) rmSync(clonePath, { recursive: true });

  exec(`git clone ${gitlabUrl} "${clonePath}"`);
  exec(`git -C "${clonePath}" checkout develop`);
  exec(`git -C "${clonePath}" checkout -b ${CONFIG.BRANCH_NAME}`);
  exec(`git -C "${clonePath}" config user.email "migration@automated.com"`);
  exec(`git -C "${clonePath}" config user.name "Migration Bot"`);

  const githubDir = `${clonePath}\\.github`;
  if (existsSync(githubDir)) {
    rmSync(githubDir, { recursive: true });
    exec(`git -C "${clonePath}" add -A`);
  }

  writeFileSync(`${clonePath}\\.gitlab-ci.yml`, GITLAB_CI_CONTENT);
  exec(`git -C "${clonePath}" add .gitlab-ci.yml`);

  const nugetConfigPaths = [
    `${clonePath}\\nuget.config`,
    `${clonePath}\\NuGet.config`,
    `${clonePath}\\NuGet.Config`,
  ];

  for (const configPath of nugetConfigPaths) {
    if (existsSync(configPath)) {
      let content = readFileSync(configPath, "utf-8");
      content = content.replace(GITHUB_NUGET_URL, GITLAB_NUGET_URL);
      writeFileSync(configPath, content);
      exec(`git -C "${clonePath}" add -A`);
      break;
    }
  }

  exec(`git -C "${clonePath}" commit -m "chore: migrate from GitHub to GitLab"`);
  exec(`git -C "${clonePath}" push origin ${CONFIG.BRANCH_NAME}`);

  rmSync(clonePath, { recursive: true });
}

function isStable(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function isBeta(version) {
  return /^\d+\.\d+\.\d+-beta$/.test(version);
}

async function main() {
  console.log(`Processing ${REPOS.length} repos\n`);

  for (const dir of [TMP_DIR, MIRROR_DIR, CLONE_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir);
  }

  const notFound = [];
  const failed = [];

  for (const repoName of REPOS) {
    console.log(`==> ${repoName}`);

    const projectId = await fetchGitlabProjectId(repoName);
    if (!projectId) {
      console.warn(`  GitLab project not found, skipping`);
      notFound.push(repoName);
      continue;
    }

    process.stdout.write(`  [1/3] Mirror GitHub -> GitLab...`);
    try {
      mirrorRepo(repoName);
      process.stdout.write(` Done\n`);
    } catch (err) {
      process.stdout.write(` FAILED\n`);
      console.error(`    ${err.message}`);
      failed.push(`${repoName}@mirror`);
      continue;
    }

    const pkg = await fetchGithubPackage(repoName);
    if (pkg) {
      const allVersions = await fetchPackageVersions(repoName);
      const names = allVersions.map((v) => v.name);
      const selected = [
        ...names.filter(isStable).slice(0, 10),
        ...names.filter(isBeta).slice(0, 10),
      ];

      if (selected.length > 0) {
        console.log(`  [2/3] Migrating ${selected.length} packages...`);
        for (const version of selected) {
          const fileName = `${repoName.toLowerCase()}.${version.toLowerCase()}.nupkg`;
          const tmpPath = `${TMP_DIR}\\${fileName}`;

          try {
            process.stdout.write(`    [${version}] Downloading...`);
            await downloadNupkg(repoName, version, tmpPath);
            process.stdout.write(` Uploading...`);
            await uploadToGitlab(projectId, tmpPath);
            process.stdout.write(` Done\n`);
          } catch (err) {
            process.stdout.write(` FAILED\n`);
            console.error(`      ${err.message}`);
            failed.push(`${repoName}@${version}`);
          }
        }
      } else {
        console.log(`  [2/3] No versions found, skipping packages`);
      }
    } else {
      console.log(`  [2/3] No GitHub package found, skipping packages`);
    }

    process.stdout.write(`  [3/3] Adjusting repo...`);
    try {
      adjustRepo(repoName);
      process.stdout.write(` Done\n`);
    } catch (err) {
      process.stdout.write(` FAILED\n`);
      console.error(`    ${err.message}`);
      failed.push(`${repoName}@adjust`);
    }

    console.log();
  }

  for (const dir of [TMP_DIR, MIRROR_DIR, CLONE_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }

  console.log(`Migration complete`);

  if (notFound.length > 0) {
    writeFileSync("not-found.txt", notFound.join("\n"));
    console.log(`not-found.txt: ${notFound.length} repos not found`);
  }

  if (failed.length > 0) {
    writeFileSync("failed.txt", failed.join("\n"));
    console.log(`failed.txt: ${failed.length} items failed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
