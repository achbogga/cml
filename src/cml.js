const { execSync } = require('child_process');
const gitUrlParse = require('git-url-parse');
const stripAuth = require('strip-url-auth');
const globby = require('globby');
const git = require('simple-git/promise')('./');

const Gitlab = require('./drivers/gitlab');
const Github = require('./drivers/github');
const BitBucketCloud = require('./drivers/bitbucket_cloud');
const { upload, exec, watermarkUri } = require('./utils');

const {
  GITHUB_REPOSITORY,
  CI_PROJECT_URL,
  BITBUCKET_REPO_UUID,
  CI
} = process.env;

const GIT_USER_NAME = 'Olivaw[bot]';
const GIT_USER_EMAIL = 'olivaw@iterative.ai';
const GIT_REMOTE = 'origin';
const GITHUB = 'github';
const GITLAB = 'gitlab';
const BB = 'bitbucket';

const uriNoTrailingSlash = (uri) => {
  return uri.endsWith('/') ? uri.substr(0, uri.length - 1) : uri;
};

const gitRemoteUrl = (opts = {}) => {
  const { remote = GIT_REMOTE } = opts;
  const url = execSync(`git config --get remote.${remote}.url`).toString(
    'utf8'
  );
  return stripAuth(gitUrlParse(url).toString('https').replace('.git', ''));
};

const inferToken = () => {
  const {
    REPO_TOKEN,
    repoToken,
    GITHUB_TOKEN,
    GITLAB_TOKEN,
    BITBUCKET_TOKEN
  } = process.env;
  return (
    REPO_TOKEN || repoToken || GITHUB_TOKEN || GITLAB_TOKEN || BITBUCKET_TOKEN
  );
};

const inferDriver = (opts = {}) => {
  const { repo } = opts;
  if (repo && repo.includes('github.com')) return GITHUB;
  if (repo && repo.includes('gitlab.com')) return GITLAB;
  if (repo && repo.includes('bitbucket.com')) return BB;

  if (GITHUB_REPOSITORY) return GITHUB;
  if (CI_PROJECT_URL) return GITLAB;
  if (BITBUCKET_REPO_UUID) return BB;
};

const getDriver = (opts) => {
  const { driver, repo, token } = opts;
  if (!driver) throw new Error('driver not set');

  if (driver === GITHUB) return new Github({ repo, token });
  if (driver === GITLAB) return new Gitlab({ repo, token });
  if (driver === BB) return new BitBucketCloud({ repo, token });

  throw new Error(`driver ${driver} unknown!`);
};

class CML {
  constructor(opts = {}) {
    const { driver, repo, token } = opts;

    this.repo = uriNoTrailingSlash(repo || gitRemoteUrl());
    this.token = token || inferToken();
    this.driver = driver || inferDriver({ repo: this.repo });
  }

  async headSha() {
    const { sha } = getDriver(this);
    return sha || (await exec(`git rev-parse HEAD`));
  }

  async branch() {
    const { branch } = getDriver(this);
    return branch || (await exec(`git branch --show-current`));
  }

  async commentCreate(opts = {}) {
    const {
      report: userReport,
      commitSha = await this.headSha(),
      rmWatermark
    } = opts;
    const watermark = rmWatermark
      ? ''
      : ' \n\n  ![CML watermark](https://raw.githubusercontent.com/iterative/cml/master/assets/watermark.svg)';
    const report = `${userReport}${watermark}`;

    return await getDriver(this).commentCreate({
      ...opts,
      report,
      commitSha
    });
  }

  async checkCreate(opts = {}) {
    const { headSha = await this.headSha() } = opts;

    return await getDriver(this).checkCreate({ ...opts, headSha });
  }

  async publish(opts = {}) {
    const { title = '', md, native, gitlabUploads, rmWatermark } = opts;

    let mime, uri;
    if (native || gitlabUploads) {
      ({ mime, uri } = await getDriver(this).upload(opts));
    } else {
      ({ mime, uri } = await upload(opts));
    }

    if (!rmWatermark) {
      const [, type] = mime.split('/');
      uri = watermarkUri({ uri, type });
    }

    if (md && mime.match('(image|video)/.*'))
      return `![](${uri}${title ? ` "${title}"` : ''})`;

    if (md) return `[${title}](${uri})`;

    return uri;
  }

  async runnerToken() {
    return await getDriver(this).runnerToken();
  }

  parseRunnerLog(opts = {}) {
    let { data } = opts;
    if (!data) return;

    try {
      data = data.toString('utf8');

      let log = {
        level: 'info',
        time: new Date().toISOString(),
        repo: this.repo
      };

      if (this.driver === GITHUB) {
        if (data.includes('Running job')) {
          log.job = '';
          log.status = 'job_started';
          return log;
        } else if (
          data.includes('Job') &&
          data.includes('completed with result')
        ) {
          log.job = '';
          log.status = 'job_ended';
          log.success = data.endsWith('Succeeded');
          log.level = log.success ? 'info' : 'error';
          return log;
        } else if (data.includes('Listening for Jobs')) {
          log.status = 'ready';
          return log;
        }
      }

      if (this.driver === GITLAB) {
        const { msg, job } = JSON.parse(data);

        if (msg.endsWith('received')) {
          log = { ...log, job };
          log.status = 'job_started';
          return log;
        } else if (
          msg.startsWith('Job failed') ||
          msg.startsWith('Job succeeded')
        ) {
          log = { ...log, job };
          log.status = 'job_ended';
          log.success = !msg.startsWith('Job failed');
          log.level = log.success ? 'info' : 'error';
          return log;
        } else if (msg.includes('Starting runner for')) {
          log.status = 'ready';
          return log;
        }
      }
    } catch (err) {
      console.log(`Failed parsing log: ${err.message}`);
    }
  }

  async startRunner(opts = {}) {
    return await getDriver(this).startRunner(opts);
  }

  async registerRunner(opts = {}) {
    return await getDriver(this).registerRunner(opts);
  }

  async unregisterRunner(opts = {}) {
    return await getDriver(this).unregisterRunner(opts);
  }

  async runnerByName(opts = {}) {
    return await getDriver(this).runnerByName(opts);
  }

  async runnersByLabels(opts = {}) {
    return await getDriver(this).runnersByLabels(opts);
  }

  async repoTokenCheck() {
    try {
      await this.runnerToken();
    } catch (err) {
      throw new Error(
        'REPO_TOKEN does not have enough permissions to access workflow API'
      );
    }
  }

  async prCreate(opts = {}) {
    const driver = getDriver(this);
    const {
      remote = GIT_REMOTE,
      userEmail = GIT_USER_EMAIL,
      userName = GIT_USER_NAME,
      globs = ['dvc.lock', '.gitignore'],
      md
    } = opts;

    const renderPr = (url) => {
      if (md)
        return `[CML's ${
          this.driver === GITLAB ? 'Merge' : 'Pull'
        } Request](${url})`;
      return url;
    };

    const { files } = await git.status();
    if (!files.length) {
      console.log('No files changed. Nothing to do.');
      return;
    }

    const paths = (await globby(globs)).filter((path) =>
      files.map((file) => file.path).includes(path)
    );
    if (!paths.length) {
      console.log('Input files are not affected. Nothing to do.');
      return;
    }

    const sha = await this.headSha();
    const shaShort = sha.substr(0, 8);

    const target = await this.branch();
    const source = `${target}-cml-pr-${shaShort}`;

    const branchExists = (
      await exec(
        `git ls-remote $(git config --get remote.${remote}.url) ${source}`
      )
    ).includes(source);

    if (branchExists) {
      const prs = await driver.prs();
      const { url } =
        prs.find(
          (pr) => source.endsWith(pr.source) && target.endsWith(pr.target)
        ) || {};

      if (url) return renderPr(url);
    } else {
      await exec(`git config --local user.email "${userEmail}"`);
      await exec(`git config --local user.name "${userName}"`);

      if (CI) {
        if (this.driver === GITLAB) {
          const repo = new URL(this.repo);
          repo.password = this.token;
          repo.username = driver.userName;

          await exec(`git remote rm ${remote}`);
          await exec(`git remote add ${remote} "${repo.toString()}.git"`);
        }
      }

      await exec(`git checkout -B ${target} ${sha}`);
      await exec(`git checkout -b ${source}`);
      await exec(`git add ${paths.join(' ')}`);
      await exec(`git commit -m "CML PR for ${shaShort} [skip ci]"`);
      await exec(`git push --set-upstream ${remote} ${source}`);
    }

    const title = `CML PR for ${target} ${shaShort}`;
    const description = `
Automated commits for ${this.repo}/commit/${sha} created by CML.
  `;

    const url = await driver.prCreate({
      source,
      target,
      title,
      description
    });

    return renderPr(url);
  }

  logError(e) {
    console.error(e.message);
  }
}

module.exports = {
  CML,
  GIT_USER_EMAIL,
  GIT_USER_NAME,
  GIT_REMOTE,
  default: CML
};
