const fetch = require('node-fetch');
const FormData = require('form-data');
const { URL, URLSearchParams } = require('url');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fse = require('fs-extra');
const { resolve } = require('path');

const { fetchUploadData, download, exec } = require('../utils');

const {
  IN_DOCKER,
  CI_BUILD_REF_NAME,
  CI_COMMIT_SHA,
  GITLAB_USER_EMAIL,
  GITLAB_USER_NAME
} = process.env;
const API_VER = 'v4';
class Gitlab {
  constructor(opts = {}) {
    const { repo, token } = opts;

    if (!token) throw new Error('token not found');
    if (!repo) throw new Error('repo not found');

    this.token = token;
    this.repo = repo;
  }

  async projectPath() {
    const repoBase = await this.repoBase();
    const projectPath = encodeURIComponent(
      this.repo.replace(repoBase, '').substr(1)
    );

    return projectPath;
  }

  async repoBase() {
    if (this._detected_base) return this._detected_base;

    const { origin, pathname } = new URL(this.repo);
    const possibleBases = await Promise.all(
      pathname
        .split('/')
        .filter(Boolean)
        .map(async (_, index, array) => {
          const components = [origin, ...array.slice(0, index)];
          const path = components.join('/');
          try {
            if (
              (await this.request({ url: `${path}/api/${API_VER}/version` }))
                .version
            )
              return path;
          } catch (error) {}
        })
    );

    this._detected_base = possibleBases.find(Boolean);
    if (!this._detected_base) throw new Error('GitLab API not found');

    return this._detected_base;
  }

  async commentCreate(opts = {}) {
    const { commitSha, report } = opts;

    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}/repository/commits/${commitSha}/comments`;
    const body = new URLSearchParams();
    body.append('note', report);

    const output = await this.request({ endpoint, method: 'POST', body });

    return output;
  }

  async checkCreate() {
    throw new Error('Gitlab does not support check!');
  }

  async upload(opts = {}) {
    const { repo } = this;

    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}/uploads`;
    const { size, mime, data } = await fetchUploadData(opts);
    const body = new FormData();
    body.append('file', data);

    const { url } = await this.request({ endpoint, method: 'POST', body });

    return { uri: `${repo}${url}`, mime, size };
  }

  async runnerToken() {
    const projectPath = await this.projectPath();
    const endpoint = `/projects/${projectPath}`;

    const { runnersToken } = await this.request({ endpoint });

    return runnersToken;
  }

  async registerRunner(opts = {}) {
    const { tags, name } = opts;

    const token = await this.runnerToken();
    const endpoint = `/runners`;
    const body = new URLSearchParams();
    body.append('description', name);
    body.append('tag_list', tags);
    body.append('token', token);
    body.append('locked', 'true');
    body.append('run_untagged', 'true');
    body.append('access_level', 'not_protected');

    return await this.request({ endpoint, method: 'POST', body });
  }

  async unregisterRunner(opts = {}) {
    const { name } = opts;

    const { id } = await this.runnerByName({ name });
    const endpoint = `/runners/${id}`;

    return await this.request({ endpoint, method: 'DELETE', raw: true });
  }

  async startRunner(opts) {
    const { workdir, idleTimeout, single, labels, name } = opts;

    let gpu = true;
    try {
      await exec('nvidia-smi');
    } catch (err) {
      gpu = false;
    }

    try {
      const bin = resolve(workdir, 'gitlab-runner');
      if (!(await fse.pathExists(bin))) {
        const url =
          'https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-linux-amd64';
        await download({ url, path: bin });
        await fs.chmod(bin, '777');
      }

      const { protocol, host } = new URL(this.repo);
      const { token } = await this.registerRunner({ tags: labels, name });
      const command = `${bin} --log-format="json" run-single \
        --builds-dir "${workdir}" \
        --cache-dir "${workdir}" \
        --url "${protocol}//${host}" \
        --name "${name}" \
        --token "${token}" \
        --wait-timeout ${idleTimeout} \
        --executor "${IN_DOCKER ? 'shell' : 'docker'}" \
        --docker-image "dvcorg/cml:latest" \
        --docker-runtime "${gpu ? 'nvidia' : ''}" \
        ${single ? '--max-builds 1' : ''}`;

      return spawn(command, { shell: true });
    } catch (err) {
      throw new Error(`Failed preparing Gitlab runner: ${err.message}`);
    }
  }

  async runnerByName(opts = {}) {
    const { name } = opts;

    const endpoint = `/runners?per_page=100`;
    const runners = await this.request({ endpoint, method: 'GET' });
    const runner = runners.filter(
      (runner) => runner.name === name || runner.description === name
    )[0];

    if (runner) return { id: runner.id, name: runner.name };
  }

  async runnersByLabels(opts = {}) {
    const { labels } = opts;
    const endpoint = `/runners?per_page=100?tag_list=${labels}`;
    const runners = await this.request({ endpoint, method: 'GET' });
    return runners.map((runner) => ({ id: runner.id, name: runner.name }));
  }

  async prCreate(opts = {}) {
    const projectPath = await this.projectPath();
    const { source, target, title, description } = opts;

    const endpoint = `/projects/${projectPath}/merge_requests`;
    const body = new URLSearchParams();
    body.append('source_branch', source);
    body.append('target_branch', target);
    body.append('title', title);
    body.append('description', description);

    const { webUrl } = await this.request({ endpoint, method: 'POST', body });

    return webUrl;
  }

  async prs(opts = {}) {
    const projectPath = await this.projectPath();
    const { state = 'opened' } = opts;

    const endpoint = `/projects/${projectPath}/merge_requests?state=${state}`;
    const prs = await this.request({ endpoint, method: 'GET' });

    return prs.map((pr) => {
      const { webUrl: url, source_branch: source, target_branch: target } = pr;
      return {
        url,
        source,
        target
      };
    });
  }

  async request(opts = {}) {
    const { token } = this;
    const { endpoint, method = 'GET', body, raw } = opts;
    let { url } = opts;

    if (endpoint) {
      url = `${await this.repoBase()}/api/${API_VER}${endpoint}`;
    }
    if (!url) throw new Error('Gitlab API endpoint not found');

    const headers = { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
    const response = await fetch(url, { method, headers, body });

    if (response.status > 300) throw new Error(response.statusText);
    if (raw) return response;

    return await response.json();
  }

  get sha() {
    return CI_COMMIT_SHA;
  }

  get branch() {
    return CI_BUILD_REF_NAME;
  }

  get userEmail() {
    return GITLAB_USER_EMAIL;
  }

  get userName() {
    return GITLAB_USER_NAME;
  }
}

module.exports = Gitlab;
