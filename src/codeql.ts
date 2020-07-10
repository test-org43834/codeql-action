import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as http from '@actions/http-client';
import * as toolcache from '@actions/tool-cache';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';

import * as util from './util';

export interface CodeQL {
  /**
   * Get the directory where the CodeQL executable is located.
   */
  getDir(): string;
  /**
   * Print version information about CodeQL.
   */
  printVersion(): Promise<void>;
  /**
   * Run 'codeql database trace-command' on 'tracer-env.js' and parse
   * the result to get environment variables set by CodeQL.
   */
  getTracerEnv(databasePath: string, compilerSpec: string | undefined): Promise<{ [key: string]: string }>;
  /**
   * Run 'codeql database init'.
   */
  databaseInit(databasePath: string, language: string, sourceRoot: string): Promise<void>;
  /**
   * Runs the autobuilder for the given language.
   */
  runAutobuild(language: string): Promise<void>;
  /**
   * Extract code for a scanned language using 'codeql database trace-command'
   * and running the language extracter.
   */
  extractScannedLanguage(database: string, language: string): Promise<void>;
  /**
   * Finalize a database using 'codeql database finalize'.
   */
  finalizeDatabase(databasePath: string): Promise<void>;
  /**
   * Run 'codeql resolve queries'.
   */
  resolveQueries(queries: string[]): Promise<ResolveQueriesOutput>;
  /**
   * Run 'codeql database analyze'.
   */
  databaseAnalyze(databasePath: string, sarifFile: string, querySuite: string): Promise<void>;
}

export interface ResolveQueriesOutput {
  byLanguage: {
    [language: string]: {
      [queryPath: string]: {}
    }
  };
  noDeclaredLanguage: {
    [queryPath: string]: {}
  };
  multipleDeclaredLanguages: {
    [queryPath: string]: {}
  };
}

/**
 * Environment variable used to store the location of the CodeQL CLI executable.
 * Value is set by setupCodeQL and read by getCodeQL.
 */
const CODEQL_ACTION_CMD = "CODEQL_ACTION_CMD";

const CODEQL_DEFAULT_BUNDLE_SUFFIX = "/codeql-bundle-20200630/codeql-bundle.tar.gz"
const GITHUB_DOTCOM_SERVER_URL = "https://github.com"
const CODEQL_DEFAULT_ACTION_REPOSITORY = "github/codeql-action";

function getCodeQLActionRepository(): string {
  // Actions do not know their own repository name, so we currently use this hack to find the name based on where our files are.
  // This can be removed once the change to the runner in https://github.com/actions/runner/pull/585 is deployed.
  const runnerTemp = util.getRequiredEnvParam("RUNNER_TEMP");
  const actionsDirectory = path.join(path.dirname(runnerTemp), "_actions");
  const relativeScriptPath = path.relative(actionsDirectory, __filename);
  if (relativeScriptPath.startsWith("..") || path.isAbsolute(relativeScriptPath)) {
    return CODEQL_DEFAULT_ACTION_REPOSITORY;
  }
  const relativeScriptPathParts = relativeScriptPath.split(path.sep);
  return relativeScriptPathParts[0] + "/" + relativeScriptPathParts[1];
}

async function getCodeQLBundleDownloadURL(): Promise<string> {
  let token = core.getInput('token', { required: true });
  const githubServerURL = process.env["GITHUB_SERVER_URL"] || GITHUB_DOTCOM_SERVER_URL;
  const codeQLActionRepository = getCodeQLActionRepository();
  const potentialDownloadURLs = [
    // This GitHub instance, and this Action.
    githubServerURL + "/" + codeQLActionRepository + "/releases/download" + CODEQL_DEFAULT_BUNDLE_SUFFIX,
    // This GitHub instance, and the canonical Action.
    githubServerURL + "/" + CODEQL_DEFAULT_ACTION_REPOSITORY + "/releases/download" + CODEQL_DEFAULT_BUNDLE_SUFFIX,
    // GitHub.com, and this Action.
    GITHUB_DOTCOM_SERVER_URL + "/" + codeQLActionRepository + "/releases/download" + CODEQL_DEFAULT_BUNDLE_SUFFIX,
    // GitHub.com, and the canonical Action.
    GITHUB_DOTCOM_SERVER_URL + "/" + CODEQL_DEFAULT_ACTION_REPOSITORY + "/releases/download" + CODEQL_DEFAULT_BUNDLE_SUFFIX,
  ];
  // We now filter out any duplicates. Duplicates will happen either because the GitHub instance is GitHub.com, or because the Action is not a fork.
  const uniqueDownloadURLs = potentialDownloadURLs.filter((url, index, self) => index === self.indexOf(url));
  const httpClient = new http.HttpClient("CodeQL-Action", undefined);
  for (let downloadURL of uniqueDownloadURLs) {
    let headers = {};
    if (!downloadURL.startsWith(GITHUB_DOTCOM_SERVER_URL + "/")) {
      // On GitHub Enterprise we have to send an Authorization header to access the bundle.
      headers["Authorization"] = "token " + token;
    }
    try {
      // This should ideally be a HEAD request, but unfortunately if we get redirected to S3 a HEAD request will not match the signed URL.
      const response = await httpClient.get(downloadURL, headers);
      if (response.message.statusCode === undefined || response.message.statusCode >= 400) {
        core.info(`Looked for CodeQL bundle at ${downloadURL} but got response code ${response.message.statusCode}.`);
      }
      else {
        core.info(`Found CodeQL bundle at ${downloadURL}.`);
        return downloadURL;
      }
    }
    catch (e) {
      core.info(`Looked for CodeQL bundle at ${downloadURL} but got error ${e}.`);
    }
  }
  throw new Error("Could not access CodeQL bundle.");
}

export async function setupCodeQL(): Promise<CodeQL> {
  try {
    let codeqlURL = core.getInput('tools');
    const codeqlURLVersion = getCodeQLURLVersion(codeqlURL || CODEQL_DEFAULT_BUNDLE_SUFFIX);

    let codeqlFolder = toolcache.find('CodeQL', codeqlURLVersion);
    if (codeqlFolder) {
      core.debug(`CodeQL found in cache ${codeqlFolder}`);
    } else {
      if (!codeqlURL) {
        codeqlURL = await getCodeQLBundleDownloadURL();
      }
      const codeqlPath = await toolcache.downloadTool(codeqlURL);
      const codeqlExtracted = await toolcache.extractTar(codeqlPath);
      codeqlFolder = await toolcache.cacheDir(codeqlExtracted, 'CodeQL', codeqlURLVersion);
    }

    let codeqlCmd = path.join(codeqlFolder, 'codeql', 'codeql');
    if (process.platform === 'win32') {
      codeqlCmd += ".exe";
    } else if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error("Unsupported plaform: " + process.platform);
    }

    core.exportVariable(CODEQL_ACTION_CMD, codeqlCmd);
    return getCodeQLForCmd(codeqlCmd);

  } catch (e) {
    core.error(e);
    throw new Error("Unable to download and extract CodeQL CLI");
  }
}

export function getCodeQLURLVersion(url: string): string {

  const match = url.match(/\/codeql-bundle-(.*)\//);
  if (match === null || match.length < 2) {
    throw new Error(`Malformed tools url: ${url}. Version could not be inferred`);
  }

  let version = match[1];

  if (!semver.valid(version)) {
    core.debug(`Bundle version ${version} is not in SemVer format. Will treat it as pre-release 0.0.0-${version}.`);
    version = '0.0.0-' + version;
  }

  const s = semver.clean(version);
  if (!s) {
    throw new Error(`Malformed tools url ${url}. Version should be in SemVer format but have ${version} instead`);
  }

  return s;
}

export function getCodeQL(): CodeQL {
  const codeqlCmd = util.getRequiredEnvParam(CODEQL_ACTION_CMD);
  return getCodeQLForCmd(codeqlCmd);
}

function getCodeQLForCmd(cmd: string): CodeQL {
  return {
    getDir: function() {
      return path.dirname(cmd);
    },
    printVersion: async function() {
      await exec.exec(cmd, [
        'version',
        '--format=json'
      ]);
    },
    getTracerEnv: async function(databasePath: string, compilerSpec: string | undefined) {
      let envFile = path.resolve(databasePath, 'working', 'env.tmp');
      const compilerSpecArg = compilerSpec ? ["--compiler-spec=" + compilerSpec] : [];
      await exec.exec(cmd, [
        'database',
        'trace-command',
        databasePath,
        ...compilerSpecArg,
        process.execPath,
        path.resolve(__dirname, 'tracer-env.js'),
        envFile
      ]);
      return JSON.parse(fs.readFileSync(envFile, 'utf-8'));
    },
    databaseInit: async function(databasePath: string, language: string, sourceRoot: string) {
      await exec.exec(cmd, [
        'database',
        'init',
        databasePath,
        '--language=' + language,
        '--source-root=' + sourceRoot,
      ]);
    },
    runAutobuild: async function(language: string) {
      const cmdName = process.platform === 'win32' ? 'autobuild.cmd' : 'autobuild.sh';
      const autobuildCmd = path.join(path.dirname(cmd), language, 'tools', cmdName);

      // Update JAVA_TOOL_OPTIONS to contain '-Dhttp.keepAlive=false'
      // This is because of an issue with Azure pipelines timing out connections after 4 minutes
      // and Maven not properly handling closed connections
      // Otherwise long build processes will timeout when pulling down Java packages
      // https://developercommunity.visualstudio.com/content/problem/292284/maven-hosted-agent-connection-timeout.html
      let javaToolOptions = process.env['JAVA_TOOL_OPTIONS'] || "";
      process.env['JAVA_TOOL_OPTIONS'] = [...javaToolOptions.split(/\s+/), '-Dhttp.keepAlive=false', '-Dmaven.wagon.http.pool=false'].join(' ');

      await exec.exec(autobuildCmd);
    },
    extractScannedLanguage: async function(databasePath: string, language: string) {
      // Get extractor location
      let extractorPath = '';
      await exec.exec(
        cmd,
        [
          'resolve',
          'extractor',
          '--format=json',
          '--language=' + language
        ],
        {
          silent: true,
          listeners: {
            stdout: (data) => { extractorPath += data.toString(); },
            stderr: (data) => { process.stderr.write(data); }
          }
        });

      // Set trace command
      const ext = process.platform === 'win32' ? '.cmd' : '.sh';
      const traceCommand = path.resolve(JSON.parse(extractorPath), 'tools', 'autobuild' + ext);

      // Run trace command
      await exec.exec(cmd, [
        'database',
        'trace-command',
        databasePath,
        '--',
        traceCommand
      ]);
    },
    finalizeDatabase: async function(databasePath: string) {
      await exec.exec(cmd, [
        'database',
        'finalize',
        databasePath
      ]);
    },
    resolveQueries: async function(queries: string[]) {
      let output = '';
      await exec.exec(
        cmd,
        [
          'resolve',
          'queries',
          ...queries,
          '--format=bylanguage'
        ],
        {
          listeners: {
            stdout: (data: Buffer) => {
              output += data.toString();
            }
          }
        });

      return JSON.parse(output);
    },
    databaseAnalyze: async function(databasePath: string, sarifFile: string, querySuite: string) {
      await exec.exec(cmd, [
        'database',
        'analyze',
        util.getMemoryFlag(),
        util.getThreadsFlag(),
        databasePath,
        '--format=sarif-latest',
        '--output=' + sarifFile,
        '--no-sarif-add-snippets',
        querySuite
      ]);
    }
  };
}
