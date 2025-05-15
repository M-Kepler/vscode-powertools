/**
 * This file is part of the vscode-powertools distribution.
 * Copyright (c) Next.e.GO Mobile SE, Aachen, Germany (https://www.e-go-mobile.com/)
 *
 * vscode-powertools is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation, version 3.
 *
 * vscode-powertools is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import * as _ from 'lodash';
import * as childProcess from 'child_process';
import * as ego_code from './code';
import * as ego_contracts from './contracts';
import * as ego_helpers from './helpers';
import * as ego_states from './states';
import * as ego_stores from './stores';
import * as ego_values from './values';
import * as ego_workspaces_apps from './workspaces/apps';
import * as ego_workspaces_buttons from './workspaces/buttons';
import * as ego_workspaces_commands from './workspaces/commands';
import * as ego_workspaces_config from './workspaces/config';
import * as ego_workspaces_events from './workspaces/events';
import * as ego_workspaces_jobs from './workspaces/jobs';
import * as ego_workspaces_npm from './workspaces/npm';
import * as ego_workspaces_startup from './workspaces/startup';
import * as fsExtra from 'fs-extra';
import * as path from 'path';
import pQueue from 'p-queue';
import * as vscode from 'vscode';


/**
 * A context for a workspace instaqnce.
 */
export interface WorkspaceContext {
    /**
     * The extension context.
     */
    readonly extension: vscode.ExtensionContext;
    /**
     * The underlying file system watcher.
     */
    readonly fileWatcher: vscode.FileSystemWatcher;
    /**
     * The logger for that workspace.
     */
    readonly logger: ego_helpers.Logger;
    /**
     * The output channel.
     */
    readonly output: vscode.OutputChannel;
    /**
     * The underlying queue for handling concurrent actions between all workspaces.
     */
    readonly queue: pQueue;
}

/**
 * A function that provides workspaces.
 *
 * @return {Workspace|Workspace[]} The workspace(s).
 */
export type WorkspaceProvider = () => Workspace | Workspace[];

/**
 * Workspace settings.
 */
export interface WorkspaceSettings extends ego_contracts.ExtensionConfiguration {
}


let allWorkspacesProvider: WorkspaceProvider;


/**
 * Handles a workspace.
 */
export class Workspace extends ego_helpers.WorkspaceBase {
    private _configSrc: ego_helpers.WorkspaceConfigSource;
    private _isInitialized = false;
    private readonly _QUEUE = ego_helpers.createQueue();
    private _scriptStates: ego_contracts.FileStateStorage;
    private _settings: WorkspaceSettings;

    /**
     * Initializes a new instance of that class.
     *
     * @param {number} id The ID of the workspace.
     * @param {vscode.WorkspaceFolder} folder The folder instance.
     * @param {WorkspaceContext} context The context.
     */
    public constructor(
        public readonly id: number,
        folder: vscode.WorkspaceFolder,
        public readonly context: WorkspaceContext,
    ) {
        super(folder);
    }

    /**
     * @inheritdoc
     */
    public get configSource() {
        return this._configSrc;
    }

    /**
     * Checks if a conditional object does match items condition.
     *
     * @param {ego_contracts.Conditional} obj The object to check.
     *
     * @return {boolean} Matches condition or not.
     */
    public doesMatchFilterCondition(obj: ego_contracts.Conditional): boolean {
        return this.filterConditionals(
            obj
        ).length > 0;
    }

    /**
     * Checks if a platform object does match the (current) platform.
     *
     * @param {ego_contracts.Conditional} obj The object to check.
     *
     * @return {boolean} Matches condition or not.
     */
    public doesMatchPlatformCondition(obj: ego_contracts.ForPlatforms): boolean {
        return this.filterForPlatform(
            obj
        ).length > 0;
    }

    /**
     * Executes code for that workspace.
     *
     * @param {string} code The code to execute.
     * @param {ego_contracts.Value|ego_contracts.Value[]} [values] One or more additional value.
     *
     * @return {any} The result of the execution.
     */
    public executeCode(
        code: string,
        values?: ego_contracts.Value | ego_contracts.Value[],
    ): any {
        code = ego_helpers.toStringSafe(code);
        if ('' === code.trim()) {
            return;
        }

        return ego_code.run({
            code: code,
            values: ego_values.toValueStorage(
                this.getValues(true)
                    .concat( ego_helpers.asArray(values) )
            ),
        });
    }

    /**
     * Executes the code in 'onEditorChanged' of an object for that workspace.
     *
     * @param {TObj|TObj[]} objs One or more objects.
     * @param {Function} codeExecutor A custom code executor.
     */
    public executeOnEditorChangedEvents<
        TObj extends ego_contracts.WithEditorChangedEvents,
    >(
        objs: TObj | TObj[],
        codeExecutor?: (code: string, obj: TObj) => any,
    ) {
        if (arguments.length < 2) {
            codeExecutor = (code) => {
                return this.executeCode(code);
            };
        }

        return ego_helpers.executeOnEditorChangedEvents(
            objs, codeExecutor
        );
    }

    /**
     * Executes a script.
     *
     * @param {TSettings} settings The object with the settings.
     * @param {Function} argsFactory The function that produces the argument object for the execution.
     *
     * @return {Promise<any>} The promise with the result of the execution.
     */
    public async executeScript<
        TArgs extends ego_contracts.WorkspaceScriptArguments,
        TSettings extends ego_contracts.WithScript = ego_contracts.WithScript
    >(
        settings: TSettings,
        argsFactory: (args: TArgs, settings: TSettings) => TArgs | PromiseLike<TArgs>
    ): Promise<any> {
        const SCRIPT_PATH = this.replaceValues(
            settings.script
        );

        const FULL_SCRIPT_PATH = this.getExistingFullPath(
            SCRIPT_PATH
        );

        if (false === FULL_SCRIPT_PATH) {
            throw new Error(`Script '${ SCRIPT_PATH }' not found!`);
        }

        const SCRIPT_MODULE = ego_helpers.loadScriptModule<ego_contracts.ScriptModule>(
            FULL_SCRIPT_PATH
        );
        if (SCRIPT_MODULE) {
            if (SCRIPT_MODULE.execute) {
                const BASE_ARGS: ego_contracts.WorkspaceScriptArguments = {
                    extension: this.context.extension,
                    globals: ego_helpers.cloneObject(this.settings.globals),
                    globalState: ego_states.GLOBAL_STATE,
                    globalStore: new ego_stores.UserStore(),
                    logger: this.logger,
                    options: ego_helpers.cloneObject(settings.options),
                    output: this.output,
                    replaceValues: (val) => {
                        return this.replaceValues(val);
                    },
                    require: (id) => {
                        return ego_helpers.requireModule(id);
                    },
                    state: undefined,
                    store: new ego_stores.UserStore(FULL_SCRIPT_PATH),
                };

                // BASE_ARGS.state
                const STATE_GETTER_SETTER = ego_states.getScriptState(
                    FULL_SCRIPT_PATH, this.scriptStates,
                    ego_helpers.getInitialStateValue(settings)
                );
                Object.defineProperty(BASE_ARGS, 'state', {
                    enumerable: true,
                    get: STATE_GETTER_SETTER.get,
                    set: STATE_GETTER_SETTER.set,
                });

                const ARGS: TArgs = await Promise.resolve(
                    argsFactory(
                        <any>BASE_ARGS, settings
                    )
                );

                return await Promise.resolve(
                    SCRIPT_MODULE.execute(ARGS)
                );
            }
        }
    }

    /**
     * Filters "conditional" items.
     *
     * @param {TObj|TObj[]} objs The objects to check.
     *
     * @return {TObj[]} The filtered items.
     */
    public filterConditionals<TObj extends ego_contracts.Conditional = ego_contracts.Conditional>(
        objs: TObj | TObj[]
    ): TObj[] {
        return ego_helpers.asArray(objs).filter(o => {
            try {
                const IF = ego_helpers.toStringSafe(o.if);
                if ('' !== IF.trim()) {
                    const ALL_VALUES = this.getValues(true);

                    const VALUES: any = {};
                    ALL_VALUES.forEach(v => {
                        Object.defineProperty(VALUES, v.name, {
                            enumerable: true,
                            get: () => {
                                return v.value;
                            },
                        });
                    });

                    return ego_helpers.toBooleanSafe(
                        ego_code.run({
                            code: IF,
                            values: VALUES,
                        }),
                        true
                    );
                }

                return true;
            } catch (e) {
                this.logger
                    .trace(e, 'workspace.Workspace.filterConditionals(1)');

                return false;
            }
        });
    }

    /**
     * Filters "platform" items.
     *
     * @param {TObj|TObj[]} objs The objects to check.
     *
     * @return {TObj[]} The filtered items.
     */
    public filterForPlatform<TObj extends ego_contracts.ForPlatforms>(
        objs: TObj | TObj[]
    ): TObj[] {
        return ego_helpers.filterForPlatform(
            objs
        );
    }

    /**
     * Returns all apps of that workspace.
     *
     * @return {ego_contracts.WorkspaceApp[]} The list of apps.
     */
    public getApps(): ego_contracts.WorkspaceApp[] {
        return ego_helpers.asArray(
            this.instanceState[
                ego_workspaces_apps.KEY_APPS
            ]
        );
    }

    /**
     * Returns all commands of that workspace.
     *
     * @return {ego_contracts.WorkspaceCommand[]} The list of commands.
     */
    public getCommands(): ego_contracts.WorkspaceCommand[] {
        return ego_helpers.asArray(
            this.instanceState[
                ego_workspaces_commands.KEY_COMMANDS
            ]
        );
    }

    /**
     * Returns all config imports of that workspace.
     *
     * @return {ego_contracts.WorkspaceConfigImport[]} The list of config imports.
     */
    public getConfigImports(): ego_contracts.WorkspaceConfigImport[] {
        return ego_helpers.asArray(
            this.instanceState[
                ego_workspaces_config.KEY_CONFIG_IMPORTS
            ]
        );
    }

    /**
     * Returns all events of that workspace.
     *
     * @return {ego_contracts.WorkspaceEvent[]} The list of events.
     */
    public getEvents(): ego_contracts.WorkspaceEvent[] {
        return ego_helpers.asArray(
            this.instanceState[
                ego_workspaces_events.KEY_EVENTS
            ]
        );
    }

    /**
     * Returns all events of that workspace by type.
     *
     * @param {string} type The type.
     *
     * @return {ego_contracts.WorkspaceEvent[]} The list of events.
     */
    public getEventsBy(type: string): ego_contracts.WorkspaceEvent[] {
        type = ego_helpers.normalizeString(type);

        return this.getEvents()
            .filter(e => {
                const EVENT_TYPE = ego_helpers.normalizeString(e.type);

                return EVENT_TYPE === type ||
                       EVENT_TYPE === '';
            });
    }

    /**
     * Returns the full path of an existing file.
     *
     * @param {string} p The input path value.
     *
     * @return {string|false} The full path or (false) if not found.
     */
    public getExistingFullPath(p: string): string | false {
        p = ego_helpers.toStringSafe(p);
        if (path.isAbsolute(p)) {
            return fsExtra.existsSync(p) ? path.resolve(
                p
            ) : false;
        }

        for (const LU of this.getFolderLookups()) {
            const FULL_PATH = path.resolve(
                path.join(
                    LU, p
                )
            );

            if (fsExtra.existsSync(FULL_PATH)) {
                return FULL_PATH;
            }
        }

        return false;
    }

    /**
     * Returns the list of folders to lookup for relative paths.
     *
     * @return {string[]} Folder lookups.
     */
    public getFolderLookups(): string[] {
        return [
            // '.vscode' sub folder
            // insode workspace
            path.resolve(
                path.join(
                    this.rootPath, '.vscode'
                )
            ),

            // extension's suf folder
            // inside user's home directory
            ego_helpers.getExtensionDirInHome(),
        ];
    }

    /**
     * Returns the information about that workspace.
     *
     * @return {ego_contracts.WorkspaceInfo} The workspace information.
     */
    public getInfo(): ego_contracts.WorkspaceInfo {
        return {
            index: this.folder.index,
            name: this.folder.name,
            rootPath: this.rootPath,
        };
    }

    /**
     * Returns all jobs of that workspace.
     *
     * @return {ego_contracts.WorkspaceJob[]} The list of jobs.
     */
    public getJobs(): ego_contracts.WorkspaceJob[] {
        return ego_helpers.asArray(
            this.instanceState[
                ego_workspaces_jobs.KEY_JOBS
            ]
        );
    }

    /**
     * Returns the list of all values.
     *
     * @param {boolean} [all] Return also the ones from the settings. Default: (false)
     *
     * @return {ego_contracts.Value[]} The list of values.
     */
    public getValues(all?: boolean): ego_contracts.Value[] {
        all = ego_helpers.toBooleanSafe(all);

        const VALUES: ego_contracts.Value[] = [
            new ego_values.FunctionValue(() => {
                return this.id;
            }, 'workspaceId'),
            new ego_values.FunctionValue(() => {
                return this.folder.index;
            }, 'workspaceIndex'),
            new ego_values.FunctionValue(() => {
                return this.folder.name;
            }, 'workspaceName'),
            new ego_values.FunctionValue(() => {
                return this.rootPath;
            }, 'workspaceRoot'),
            new ego_values.FunctionValue(() => {
                return this.folder.uri;
            }, 'workspaceUri'),
        ];

        if (all) {
            ego_helpers.from(
                ego_values.toValues(
                    this.settings,
                    {
                        outputProvider: () => {
                            return this.output;
                        },
                        pathResolver: (p) => {
                            return this.resolveValuePath(p);
                        },
                    }
                ),
            ).pushTo(
                VALUES
            );
        }

        return VALUES;
    }

    /**
     * Imports values to an object.
     *
     * @param {TObj} obj The object where to import the values in.
     * @param {boolean} [clone] Clone input object or not. Default: (true)
     *
     * @return {TObj} The object that contains the imported values.
     */
    public importValues<TObj extends ego_contracts.CanImportValues = ego_contracts.CanImportValues>(
        obj: TObj,
        clone?: boolean,
    ): TObj {
        return ego_helpers.importValues(
            obj,
            () => this.getValues(true),
            clone,
        );
    }

    /**
     * Initializes the workspace.
     */
    public async initialize() {
        this._configSrc = {
            section: 'ego.power-tools',
            resource: vscode.Uri.file(path.join(this.rootPath,
                                                '.vscode/settings.json') ),
        };

        this.instanceState[
            ego_workspaces_config.KEY_CONFIG_IMPORTS
        ] = [];
        this.instanceState[
            ego_workspaces_apps.KEY_APPS
        ] = [];
        this.instanceState[
            ego_workspaces_buttons.KEY_BUTTONS
        ] = [];
        this.instanceState[
            ego_workspaces_commands.KEY_COMMANDS
        ] = [];
        this.instanceState[
            ego_workspaces_events.KEY_EVENTS
        ] = [];
        this.instanceState[
            ego_workspaces_jobs.KEY_JOBS
        ] = [];

        // file change events
        {
            const RAISE_FILE_CHANGE = (type: ego_contracts.FileChangeType, file: vscode.Uri) => {
                this._QUEUE.add(async () => {
                    await this.onFileChange(type, file);
                }).then(() => {
                }).catch((err) => {
                    this.logger.trace(
                        err, 'workspace.onFileChange(1)'
                    );
                });
            };

            this.context.fileWatcher.onDidChange((f) => {
                RAISE_FILE_CHANGE(ego_contracts.FileChangeType.Changed, f);
            });
            this.context.fileWatcher.onDidCreate((f) => {
                RAISE_FILE_CHANGE(ego_contracts.FileChangeType.Created, f);
            });
            this.context.fileWatcher.onDidDelete((f) => {
                RAISE_FILE_CHANGE(ego_contracts.FileChangeType.Deleted, f);
            });
        }

        try {
            this._isInitialized = true;
            await this.reloadConfiguration();
        } catch (e) {
            this.logger.trace(
                e, 'workspace.initialize(1)'
            );

            return false;
        }

        return true;
    }

    /**
     * A key/value pair for data for that instance.
     */
    public readonly instanceState: { [key: string]: any } = {};

    /**
     * Gets if workspace has been initialized or not.
     */
    public get isInitialized() {
        return this._isInitialized;
    }

    /**
     * Checks if a path is inside the '.git' folder.
     *
     * @param {string} p The path to check.
     *
     * @return {boolean} Is in '.git' folder or not.
     */
    public isInGit(p: string): boolean {
        p = ego_helpers.toStringSafe(p);
        if (!path.isAbsolute(p)) {
            p = path.join(
                this.rootPath, p
            );
        }
        p = path.resolve(p);

        const GIT_FOLDER = path.resolve(
            path.join(
                this.rootPath, '.git'
            )
        );

        return p.startsWith(GIT_FOLDER + path.sep) ||
               GIT_FOLDER === p;
    }

    /**
     * Checks if a path is inside the '.vscode' folder.
     *
     * @param {string} p The path to check.
     *
     * @return {boolean} Is in '.vscode' folder or not.
     */
    public isInVscode(p: string): boolean {
        p = ego_helpers.toStringSafe(p);
        if (!path.isAbsolute(p)) {
            p = path.join(
                this.rootPath, p
            );
        }
        p = path.resolve(p);

        const VSCODE_FOLDER = path.resolve(
            path.join(
                this.rootPath, '.vscode'
            )
        );

        return p.startsWith(VSCODE_FOLDER + path.sep) ||
               VSCODE_FOLDER === p;
    }

    /**
     * Checks if a path is part of that workspace.
     *
     * @param {string} path The path to check.
     *
     * @return {boolean} Is part of that workspace or not.
     */
    public isPathOf(path: string) {
        return false !== this.toFullPath(path);
    }

    /**
     * Gets the logger of that workspace.
     */
    public get logger() {
        return this.context.logger;
    }

    /**
     * @inheritdoc
     */
    public async onDidChangeConfiguration(e: vscode.ConfigurationChangeEvent) {
        await this._QUEUE.add(async () => {
            await this.reloadConfiguration();
        });
    }

    /**
     * Is invoked when a text document has been opened.
     *
     * @param {vscode.TextDocument} doc The underlying text document.
     */
    public async onDidOpenTextDocument(doc: vscode.TextDocument) {
        await this._QUEUE.add(async () => {
            await this.onDocumentOpened(
                doc
            );
        });
    }

    /**
     * Is invoked when a text document has been saved.
     *
     * @param {vscode.TextDocument} doc The underlying text document.
     */
    public async onDidSaveTextDocument(doc: vscode.TextDocument) {
        await this._QUEUE.add(async () => {
            await this.onFileChange(
                ego_contracts.FileChangeType.Saved, doc.uri,
                doc
            );
        });
    }

    /**
     * @inheritdoc
     */
    protected onDispose() {
        if (!this.isInitialized) {
            return;
        }

        ego_helpers.tryDispose(this.context.fileWatcher);

        // config imports
        ego_workspaces_config.disposeConfigImports.apply(
            this
        );
        // events
        ego_workspaces_events.disposeEvents.apply(
            this
        );
        // jobs
        ego_workspaces_jobs.disposeJobs.apply(
            this
        );
        // buttons
        // 3. 触发事件
        ego_workspaces_buttons.disposeButtons.apply(
            this
        );
        // apps
        ego_workspaces_apps.disposeApps.apply(
            this
        );
        // commands
        ego_workspaces_commands.disposeCommands.apply(
            this
        );
    }

    private async onDocumentOpened(doc: vscode.TextDocument) {
        if (this.isInFinalizeState) {
            return;
        }

        // do not handle items inside
        // the following folders
        if (this.isInGit(doc.fileName)) {
            return;
        }
        if (this.isInVscode(doc.fileName)) {
            return;
        }

        const EVENT_TYPE = 'document.opened';

        const EVENTS = this.getEventsBy(EVENT_TYPE);
        for (const E of EVENTS) {
            try {
                await Promise.resolve(
                    E.execute(EVENT_TYPE,
                              doc)
                );
            } catch (e) {
                this.logger
                    .trace(e, 'workspace.onDocumentOpened(1)');
            }
        }
    }

    private async onFileChange(
        type: ego_contracts.FileChangeType, file: vscode.Uri,
        doc?: vscode.TextDocument,
        ...args: any[]
    ) {
        if (this.isInFinalizeState) {
            return;
        }

        // do not handle items inside
        // the following folders
        if (this.isInGit(file.fsPath)) {
            return;
        }
        if (this.isInVscode(file.fsPath)) {
            return;
        }

        if (arguments.length < 3) {
            const EDITORS = ego_helpers.asArray(
                vscode.window.visibleTextEditors
            );

            for (const E of EDITORS) {
                const EDITORS_DOC = E.document;
                if (EDITORS_DOC) {
                    if (!ego_helpers.isEmptyString(EDITORS_DOC.fileName)) {
                        if (path.resolve(EDITORS_DOC.fileName) === path.resolve(file.fsPath)) {
                            doc = EDITORS_DOC;
                        }
                    }
                }
            }
        }

        let eventType: string;
        switch (type) {
            case ego_contracts.FileChangeType.Changed:
                eventType = 'file.changed';
                break;

            case ego_contracts.FileChangeType.Created:
                eventType = 'file.created';
                break;

            case ego_contracts.FileChangeType.Deleted:
                eventType = 'file.deleted';
                break;

            case ego_contracts.FileChangeType.Saved:
                eventType = 'file.saved';
                break;

            case ego_contracts.FileChangeType.WillSave:
                eventType = 'file.willsave';
                break;
        }

        const EVENTS = this.getEventsBy(eventType);
        for (const E of EVENTS) {
            try {
                await Promise.resolve(
                    E.execute.apply(
                        E,
                        [eventType, type, file, doc].concat(args)
                    )
                );
            } catch (e) {
                this.logger
                    .trace(e, 'workspace.onFileChange(1)');
            }
        }
    }

    /**
     * Is invoked when a text document is going to be saved.
     *
     * @param {vscode.TextDocumentWillSaveEvent} e The event arguments.
     */
    public async onWillSaveTextDocument(e: vscode.TextDocumentWillSaveEvent) {
        await this._QUEUE.add(async () => {
            await this.onFileChange(
                ego_contracts.FileChangeType.WillSave, e.document.uri,
                e.document,
                e,
            );
        });
    }

    /**
     * Gets the output channel.
     */
    public get output() {
        return this.context.output;
    }

    /**
     * Raises the event that config imports have changed.
     */
    public async raiseConfigImportsChanged() {
        await this._QUEUE.add(async () => {
            await this.reloadConfiguration();
        });
    }

    private async reloadConfiguration() {
        if (this.isInFinalizeState) {
            return;
        }
        if (!this.isInitialized) {
            return;
        }

        // load settings
        this._settings = await ego_workspaces_config.loadSettings.apply(
            this
        );

        this._scriptStates = {};

        // commands
        await ego_workspaces_commands.reloadCommands.apply(
            this
        );
        // apps
        await ego_workspaces_apps.reloadApps.apply(
            this
        );
        // buttons
        await ego_workspaces_buttons.reloadButtons.apply(
            this
        );
        // jobs
        await ego_workspaces_jobs.reloadJobs.apply(
            this
        );
        // events
        await ego_workspaces_events.reloadEvents.apply(
            this
        );

        // startups !!!THIS HAS TO BE DONE AT LAST!!!
        await ego_workspaces_npm.runNPMStartupTasks.apply(
            this
        );
        await ego_workspaces_startup.onStartup.apply(
            this
        );
    }

    /**
     * Handles a value as string and replaces placeholders.
     *
     * @param {any} val The input value.
     *
     * @return {string} The output value.
     */
    public replaceValues(val: any): string {
        val = ego_helpers.toStringSafe(val);

        if (!this.isInFinalizeState) {
            if (this.isInitialized) {
                val = ego_values.replaceValues(this.settings, val, {
                    buildInValues: this.getValues(),
                    pathResolver: (p: string) => {
                        return this.resolveValuePath(p);
                    },
                });
            }
        }

        return val;
    }

    private resolveValuePath(p: string) {
        p = ego_helpers.toStringSafe(p);

        if (path.isAbsolute(p)) {
            p = path.resolve(p);

            if (fsExtra.existsSync(p)) {
                return p;
            }
        } else {
            // 遍历所有 .vscode 文件夹
            for (const LU of this.getFolderLookups()) {
                const FULL_PATH = path.resolve(
                    path.join(LU, p)
                );

                // 检查文件夹是否存在
                if (fsExtra.existsSync(FULL_PATH)) {
                    return FULL_PATH;
                }
            }
        }

        return false;
    }

    /**
     * Runs a shell command for that workspace and shows it progress in the GUI.
     *
     * @param {ego_contracts.WithShellCommand} settings Settings with the command to run.
     * @param {ego_contracts.RunShellCommandOptions} [opts] Custom options.
     */
    public async runShellCommand(settings: ego_contracts.WithShellCommand, opts?: ego_contracts.RunShellCommandOptions) {
        if (!opts) {
            opts = <any>{};
        }

        const COMMAND_TO_EXECUTE = this.replaceValues(
            settings.command
        );

        let cwd = this.replaceValues(
            settings.cwd
        );
        if (ego_helpers.isEmptyString(cwd)) {
            cwd = this.rootPath;
        }
        if (!path.isAbsolute(cwd)) {
            cwd = path.join(
                this.rootPath, cwd
            );
        }
        cwd = path.resolve(cwd);

        const SILENT = ego_helpers.toBooleanSafe(settings.silent, true);
        const WAIT = ego_helpers.toBooleanSafe(settings.wait, true);

        const WRITE_RESULT = (result: string) => {
            if (!SILENT) {
                if (!ego_helpers.isEmptyString(result)) {
                    this.output
                        .appendLine(ego_helpers.toStringSafe(result));
                    this.output
                        .appendLine('');
                }
            }
        };

        const COMMAND_ACTION = (progress: ego_contracts.ProgressContext) => {
            return new Promise<void>((resolve, reject) => {
                const COMPLETED = (err: any, result?: string) => {
                    if (err) {
                        this.output
                            .appendLine(`[FAILED: '${ ego_helpers.errorToString(err) }']`);

                        WRITE_RESULT(result);

                        reject(err);
                    } else {
                        this.output
                            .appendLine('[OK]');

                        WRITE_RESULT(result);

                        resolve();
                    }
                };

                try {
                    this.output
                        .append(`Running shell command '${ COMMAND_TO_EXECUTE }' ... `);

                    if (progress) {
                        progress.report({
                            message: `Running '${ COMMAND_TO_EXECUTE }' ...`,
                        });
                    }

                    childProcess.exec(COMMAND_TO_EXECUTE, {
                        cwd: cwd,
                    }, (err, result) => {
                        if (WAIT) {
                            COMPLETED(err, result);
                        } else {
                            if (err) {
                                this.logger
                                    .trace(err, 'workspace.Workspace.runShellCommand(1)');

                                ego_helpers.showErrorMessage(err);
                            }

                            WRITE_RESULT(result);
                        }
                    });

                    if (!WAIT) {
                        COMPLETED(null, '');
                    }
                } catch (e) {
                    COMPLETED(e);
                }
            });
        };

        // run command
        if (ego_helpers.toBooleanSafe(opts.noProgress)) {
            await COMMAND_ACTION(null);
        } else {
            await vscode.window.withProgress({
                cancellable: false,
                location: vscode.ProgressLocation.Notification,
                title: 'Shell Command',
            }, async (progress) => {
                await COMMAND_ACTION(progress);
            });
        }
    }

    /**
     * The storage with script states.
     */
    public get scriptStates(): ego_contracts.FileStateStorage {
        return this._scriptStates;
    }

    /**
     * Gets the current settings.
     */
    public get settings() {
        return this._settings;
    }

    /**
     * Converts to a full path.
     *
     * @param {string} p The path to convert.
     *
     * @return {string|false} The pull path or (false) if 'path' could not be converted.
     */
    public toFullPath(p: string): string | false {
        const RELATIVE_PATH = this.toRelativePath(p);
        if (false === RELATIVE_PATH) {
            return false;
        }

        return path.resolve(
            path.join(
                this.rootPath,
                RELATIVE_PATH
            )
        );
    }

    /**
     * Converts to a relative path.
     *
     * @param {string} p The path to convert.
     *
     * @return {string|false} The relative path or (false) if 'p' could not be converted.
     */
    public toRelativePath(p: string): string | false {
        p = ego_helpers.toStringSafe(p);
        p = path.resolve(p)
                .split(path.sep)
                .join('/');

        const WORKSPACE_DIR =
            this.rootPath
                .split(path.sep)
                .join('/');

        if (WORKSPACE_DIR !== p && !p.startsWith(WORKSPACE_DIR + '/')) {
            return false;
        }

        let relativePath = p.substr(WORKSPACE_DIR.length);
        while (relativePath.startsWith('/')) {
            relativePath = relativePath.substr(1);
        }
        while (relativePath.endsWith('/')) {
            relativePath = relativePath.substr(0, relativePath.length - 1);
        }

        return relativePath;
    }
}


/**
 * Returns a list of all workspaces.
 *
 * @return {Workspace[]} The list of all workspaces.
 */
export function getAllWorkspaces(): Workspace[] {
    const PROVIDER = allWorkspacesProvider;
    if (PROVIDER) {
        return sortWorkspaces(
            PROVIDER()
        );
    }
}

/**
 * Tries to return the current workspace.
 *
 * @return {Workspace | false} The workspace or (false) if not found.
 */
export function getCurrentWorkspace(): Workspace | false {
    try {
        const ALL_WORKSPACES = getAllWorkspaces();
        if (1 === ALL_WORKSPACES.length) {
            return ALL_WORKSPACES[0];
        } else {
            const ACTIVE_EDITOR = vscode.window.activeTextEditor;
            if (ACTIVE_EDITOR) {
                const DOC = ACTIVE_EDITOR.document;
                if (DOC) {
                    if (DOC.uri && (['', 'file'].indexOf(ego_helpers.normalizeString(DOC.uri.scheme)) > -1)) {
                        const FILE_NAME = ego_helpers.toStringSafe(DOC.uri.fsPath);
                        if (!ego_helpers.isEmptyString(FILE_NAME)) {
                            try {
                                if (path.isAbsolute(FILE_NAME)) {
                                    return ego_helpers.from(
                                        ALL_WORKSPACES
                                    ).singleOrDefault(ws => ws.isPathOf(FILE_NAME), false);
                                }
                            } catch { /** seems to have more than one matching workspace here */ }
                        }
                    }
                }
            }
        }
    } catch {
        /** ignore errors here */
    }

    return false;
}

/**
 * Returns a list of workspace infos.
 *
 * @param {Workspace|Workspace[]} [workspaces] The custom list of workspaces.
 *
 * @return {ego_contracts.WorkspaceList} The workspace list.
 */
export function getWorkspaceList(workspaces?: Workspace | Workspace[]): ego_contracts.WorkspaceList {
    if (arguments.length < 1) {
        workspaces = getAllWorkspaces();
    }

    workspaces = ego_helpers.asArray(workspaces);

    const LIST: ego_contracts.WorkspaceList = {};

    for (const WS of workspaces.map(ws => ws.getInfo())) {
        if (_.isNil(LIST[ WS.name ])) {
            LIST[ WS.name ] = WS;
        } else {
            LIST[ WS.name ] = ego_helpers.asArray(
                LIST[ WS.name ]
            );
        }
    }

    return LIST;
}

/**
 * Sets the global function for providing the list of all workspaces.
 *
 * @param {WorkspaceProvider} newProvider The new function.
 */
export function setAllWorkspacesProvider(newProvider: WorkspaceProvider) {
    allWorkspacesProvider = newProvider;
}

function sortWorkspaces(workspaces: Workspace | Workspace[]) {
    return ego_helpers.asArray(workspaces).sort((x, y) => {
        return ego_helpers.compareValuesBy(x, y, ws => {
            return ws.folder.index;
        });
    });
}
