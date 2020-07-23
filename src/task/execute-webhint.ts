import { existsSync } from 'fs';
import { join } from 'path';
import { command, debug, getInput, getVariable, setResult, TaskResult, tool, which } from 'azure-pipelines-task-lib/task';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';

const BASE_REPORT_PATH = 'webhintresult';

type ReportPaths = {
    source: string;
    destination: string;
}

/** Converts url to filename created by webhint,
 *  should really get it from somewhere else */
const convertUrlToFileName = (url: string): string => {
    return `${url.replace(/[^a-z]+/g, '-')}`;
}

/** Returns the URL to analyze provided by the user. */
const getUrl = (): string => {
    const url = getInput('url', true);

    if (!url) {
        throw new Error('URL to analyze is not defined');
    }

    return url;
};

/** Returns the user provided working directory or the source directory if none defined. */
const defineWorkingDirectory = () => {
    const workingDirectory = getVariable('System.DefaultWorkingDirectory') || process.cwd();

    if (!workingDirectory) {
        throw new Error('Working directory is not defined');
    }

    return workingDirectory;
};

/** Returns the paths to the generated HTML report files. */
const defineOutputReportPaths = (workingDirectory: string, url: string): ReportPaths => {
    const fileName = convertUrlToFileName(url);
    const source = join(workingDirectory, BASE_REPORT_PATH, `${fileName}.html`);
    const destination = join(workingDirectory, BASE_REPORT_PATH, `${fileName}-inline.html`);

    console.debug(`Expected Report Location: ${source}`);

    return { destination, source };
};

/**
 * Returns the arguments to use by webhint in the cli and creates
 * a temporary `.hintrc` file if needed.
 */
const defineCliArgs = (workingDirectory: string, url: string) => {
    const argsStr = getInput('args', false) || '';

    const illegalArgs = [
        '--output=',
        '--formatters',
        '--telemetry'
    ];

    const args = argsStr
        .split(/\r?\n/)
        .map((arg) => {
            return arg.trim();
        })
        .filter((arg) => {
            return arg.length > 0;
        })
        .filter((arg) => {
            return !illegalArgs.some((illegalArg) => {
                return arg.startsWith(illegalArg);
            });
        });

    if ((getVariable('system.debug') || '').toLowerCase() === 'true') {
        args.push('--debug');
    }

    args.push('--formatters=html');
    args.push('--telemetry=off');
    args.push(`--output=${join(workingDirectory, BASE_REPORT_PATH)}`);

    args.unshift(url);

    return args;
};

/**
 * Run webhint giving preference to the locally installed version or using `npx`
 * if no version is found.
 */
const executeWebhint = async (workingDirectory: string, url: string) => {
    const platform = process.platform;
    const hintExecutable = platform === 'win32' ?
        'hint.cmd' :
        'hint';
    const localPath = join(process.cwd(), 'node_modules', '.bin', hintExecutable);
    const args = defineCliArgs(workingDirectory, url);

    let cmd: ToolRunner;

    if (existsSync(localPath)) {
        debug(`Hint installed locally in: "${localPath}"`);

        cmd = tool(localPath);
    } else {
        // We run `hint` via npx because global installs cause problems
        const npmPath = which('npx', true);

        cmd = tool(npmPath);

        /**
         * The invocation is `npx hint URL --parameters`
         * Only `URL --parameters` is available prior here.
         */
        args.unshift('hint');

        console.warn(`Using "npx hint". This can take a bit.`);
        console.warn(`For better performance please install hint locally: "npm install hint -save-dev"`);
    }

    cmd.arg(args);

    const options = { ignoreReturnCode: true } as IExecOptions;
    const retCode = await cmd.exec(options);

    return retCode;
};

/** Publish the results of webhint if the user has decided to do so. */
const publishHTMLResults = async (reportPaths: ReportPaths) => {
    const publish = getInput('publishResults') === 'true';

    if (!publish) {
        return;
    }

    const properties = {
        name: 'webhintresult',
        type: 'webhint_html_result'
    };

    command('task.addattachment', properties, reportPaths.source);
};

const run = async () => {

    try {
        // setup environment
        const workingDirectory = defineWorkingDirectory();

        debug(`WorkingDirectory: ${workingDirectory}`);

        // read inputs
        const url = getUrl();

        const reportPaths = defineOutputReportPaths(workingDirectory, url);

        debug(`URL: ${url}`);

        // execute webhint
        const retCode = await executeWebhint(workingDirectory, url);

        console.debug(retCode);

        if (!existsSync(reportPaths.source)) {
            throw new Error(`Webhint did not generate an HTML report. Error code: ${retCode}`);
        }

        await publishHTMLResults(reportPaths);

        if (retCode === 0) {
            setResult(TaskResult.Succeeded, `No issues found by webhint.`);
        } else {
            const continueIfFailure = getInput('continueIfFailure') === 'true';
            const result = continueIfFailure ?
                TaskResult.Succeeded :
                TaskResult.Failed;

            setResult(result, `webhint found issues when analyzing ${url}. Check the results tab.`);
        }
    } catch (err) {
        // return as task failed
        setResult(TaskResult.Failed, err.message);
    }
};

run();