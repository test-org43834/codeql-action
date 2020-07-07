import * as core from '@actions/core';
import * as toolcache from '@actions/tool-cache';
import * as path from 'path';

export class CodeQLSetup {
    public dist: string;
    public tools: string;
    public cmd: string;
    public platform: string;

    constructor(codeqlDist: string) {
        this.dist = codeqlDist;
        this.tools = path.join(this.dist, 'tools');
        this.cmd = path.join(codeqlDist, 'codeql');
        // TODO check process.arch ?
        if (process.platform === 'win32') {
            this.platform = 'win64';
            if (this.cmd.endsWith('codeql')) {
                this.cmd += ".cmd";
            }
        } else if (process.platform === 'linux') {
            this.platform = 'linux64';
        } else if (process.platform === 'darwin') {
            this.platform = 'osx64';
        } else {
            throw new Error("Unsupported plaform: " + process.platform);
        }
    }
}

export async function setupCodeQL(): Promise<CodeQLSetup> {
    const version = '1.0.0';
    const codeqlURL = core.getInput('tools', { required: true });

    try {
        let codeqlFolder = toolcache.find('CodeQL', version);
        if (codeqlFolder) {
            core.debug(`CodeQL found in cache ${codeqlFolder}`);
        } else {
            const codeqlPath = await toolcache.downloadTool(codeqlURL);
            const codeqlExtracted = await toolcache.extractTar(codeqlPath);
            codeqlFolder = await toolcache.cacheDir(codeqlExtracted, 'CodeQL', version);
        }
        return new CodeQLSetup(path.join(codeqlFolder, 'codeql'));

    } catch (e) {
        core.error(e);
        throw new Error("Unable to download and extract CodeQL CLI");
    }
}

export async function setupPythonScripts(): Promise<string> {
    try {
        const repoPath = await toolcache.downloadTool("https://github.com/github/codeql-action/archive/python-setup.zip");
        const extracted = await toolcache.extractZip(repoPath);
        const scriptsFolder = await toolcache.cacheDir(extracted, 'PythonScripts', '1.0.0');
        return path.join(scriptsFolder, 'codeql-action-python-setup', 'python-setup');
    } catch (e) {
        core.error(e);
        throw new Error("Unable to download and extract the python setup scripts");
    }
}
