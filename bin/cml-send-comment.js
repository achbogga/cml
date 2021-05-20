#!/usr/bin/env node

console.log = console.error;

const fs = require('fs').promises;
const yargs = require('yargs');
const decamelize = require('decamelize-keys');

const CML = require('../src/cml').default;

const run = async (opts) => {
  const path = opts._[0];
  const report = await fs.readFile(path, 'utf-8');
  const cml = new CML(opts);
  await cml.commentCreate({ ...opts, report });
};

const opts = decamelize(
  yargs
    .strict()
    .usage('Usage: $0 <path to markdown file>')
    .default('commit-sha')
    .describe(
      'commit-sha',
      'Commit SHA linked to this comment. Defaults to HEAD.'
    )
    .alias('commit-sha', 'head-sha')
    .boolean('rm-watermark')
    .describe(
      'rm-watermark',
      'Avoid watermark. CML needs a watermark to be able to distinguish CML reports from other comments in order to provide extra functionality.'
    )
    .default('repo')
    .describe(
      'repo',
      'Specifies the repo to be used. If not specified is extracted from the CI ENV.'
    )
    .default('token')
    .describe(
      'token',
      'Personal access token to be used. If not specified in extracted from ENV REPO_TOKEN.'
    )
    .default('driver')
    .choices('driver', ['github', 'gitlab'])
    .describe('driver', 'If not specify it infers it from the ENV.')
    .help('h')
    .demand(1).argv
);

run(opts).catch((e) => {
  console.error(e);
  process.exit(1);
});
