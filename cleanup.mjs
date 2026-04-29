import { execSync } from "child_process";
import { rmSync, existsSync, mkdirSync } from "fs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const CONFIG = {
  GITLAB_HOST: "gitlab.com",
  GITLAB_GROUP: "empresa/projects/engenharia/arquitetura",
  GITLAB_TOKEN: "glpat-...",
};

const REPOS = [
  "lib-foo",
  "lib-bar",
  "lib-baz",
];

const PROTECTED_BRANCHES = ["main", "master", "develop"];

const TMP_DIR = "./tmp_cleanup";

const gitlabHeaders = {
  "PRIVATE-TOKEN": CONFIG.GITLAB_TOKEN,
  "Content-Type": "application/json",
};

function exec(cmd, options = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...options });
}

async function fetchGitlabProjectId(repoName) {
  const encoded = encodeURIComponent(`${CONFIG.GITLAB_GROUP}/${repoName}`);
  const res = await fetch(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${encoded}`,
    { headers: gitlabHeaders }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitLab project fetch failed for ${repoName}: ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function fetchAll(url) {
  const items = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      { headers: gitlabHeaders }
    );
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.length === 0) break;
    items.push(...data);
    page++;
  }
  return items;
}

async function deletePackages(projectId) {
  const packages = await fetchAll(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/packages`
  );

  if (packages.length === 0) {
    console.log(`    No packages found`);
    return;
  }

  for (const pkg of packages) {
    const res = await fetch(
      `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/packages/${pkg.id}`,
      { method: "DELETE", headers: gitlabHeaders }
    );
    if (res.ok || res.status === 204) {
      console.log(`    Deleted package: ${pkg.name} ${pkg.version}`);
    } else {
      console.warn(`    Failed to delete package: ${pkg.name} ${pkg.version} (${res.status})`);
    }
  }
}

async function deleteReleases(projectId) {
  const releases = await fetchAll(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/releases`
  );

  if (releases.length === 0) {
    console.log(`    No releases found`);
    return;
  }

  for (const release of releases) {
    const encodedTag = encodeURIComponent(release.tag_name);
    const res = await fetch(
      `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/releases/${encodedTag}`,
      { method: "DELETE", headers: gitlabHeaders }
    );
    if (res.ok || res.status === 204) {
      console.log(`    Deleted release: ${release.tag_name}`);
    } else {
      console.warn(`    Failed to delete release: ${release.tag_name} (${res.status})`);
    }
  }
}

async function deleteTags(projectId) {
  const tags = await fetchAll(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/repository/tags`
  );

  if (tags.length === 0) {
    console.log(`    No tags found`);
    return;
  }

  for (const tag of tags) {
    const encodedTag = encodeURIComponent(tag.name);
    const res = await fetch(
      `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/repository/tags/${encodedTag}`,
      { method: "DELETE", headers: gitlabHeaders }
    );
    if (res.ok || res.status === 204) {
      console.log(`    Deleted tag: ${tag.name}`);
    } else {
      console.warn(`    Failed to delete tag: ${tag.name} (${res.status})`);
    }
  }
}

async function unprotectBranch(projectId, branchName) {
  const encoded = encodeURIComponent(branchName);
  await fetch(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/protected_branches/${encoded}`,
    { method: "DELETE", headers: gitlabHeaders }
  );
}

async function deleteBranches(projectId) {
  const branches = await fetchAll(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/repository/branches`
  );

  if (branches.length === 0) {
    console.log(`    No branches found`);
    return;
  }

  for (const branch of branches) {
    if (branch.default) {
      console.log(`    Skipping default branch: ${branch.name}`);
      continue;
    }

    await unprotectBranch(projectId, branch.name);

    const encoded = encodeURIComponent(branch.name);
    const res = await fetch(
      `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/repository/branches/${encoded}`,
      { method: "DELETE", headers: gitlabHeaders }
    );
    if (res.ok || res.status === 204) {
      console.log(`    Deleted branch: ${branch.name}`);
    } else {
      console.warn(`    Failed to delete branch: ${branch.name} (${res.status})`);
    }
  }
}

async function deletePipelines(projectId) {
  const pipelines = await fetchAll(
    `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/pipelines`
  );

  if (pipelines.length === 0) {
    console.log(`    No pipelines found`);
    return;
  }

  for (const pipeline of pipelines) {
    const res = await fetch(
      `https://${CONFIG.GITLAB_HOST}/api/v4/projects/${projectId}/pipelines/${pipeline.id}`,
      { method: "DELETE", headers: gitlabHeaders }
    );
    if (res.ok || res.status === 204) {
      console.log(`    Deleted pipeline: #${pipeline.id}`);
    } else {
      console.warn(`    Failed to delete pipeline: #${pipeline.id} (${res.status})`);
    }
  }
}

async function main() {
  console.log(`Cleaning ${REPOS.length} repos\n`);

  for (const repoName of REPOS) {
    console.log(`==> ${repoName}`);

    const projectId = await fetchGitlabProjectId(repoName);
    if (!projectId) {
      console.warn(`  Project not found, skipping\n`);
      continue;
    }

    console.log(`  Project ID: ${projectId}`);

    console.log(`  Deleting packages...`);
    await deletePackages(projectId);

    console.log(`  Deleting releases...`);
    await deleteReleases(projectId);

    console.log(`  Deleting tags...`);
    await deleteTags(projectId);

    console.log(`  Deleting branches...`);
    await deleteBranches(projectId);

    console.log(`  Deleting pipelines...`);
    await deletePipelines(projectId);

    console.log(`  Done\n`);
  }

  console.log(`Cleanup complete`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
