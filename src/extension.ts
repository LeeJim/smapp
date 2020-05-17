// import * as Bluebird from "bluebird";
import * as _ from "lodash";
import * as fs from 'fs';
import * as path from "path";
import "source-map-support/register";
import * as VError from "verror";
import {
    commands, CompletionItem, CompletionItemKind,
    Definition, Disposable, ExtensionContext, languages, Location, Position, Range,
    TextDocument, TextEditor, Uri, window,
} from "vscode";
import { URI } from "vscode-uri";
import CssClassDefinition from "./common/css-class-definition";
import JSDefinition from './common/js-definition';
import CssClassesStorage from "./css-classes-storage";
import Fetcher from "./fetcher";
import Notifier from "./notifier";
import ParseEngineGateway from "./parse-engine-gateway";
import { fstat } from "fs";

const esprima = require("esprima");

const pushProto = Array.prototype.push;

const notifier: Notifier = new Notifier("smapp.cache");
let uniqueDefinitions: CssClassDefinition[] = [];
let curFileDefinitions: CssClassDefinition[] = [];
let jsFileDefinitions = new Map();

const completionTriggerChars = ['"', "'", " ", "."];

let caching: boolean = false;

async function cache(): Promise<void> {
    try {
        notifier.notify("eye", "Looking for CSS classes in the workspace...");

        console.log("Looking for parseable documents...");
        const uris: Uri[] = await Fetcher.findAllParseableDocuments("**/app.wxss");

        if (!uris || uris.length === 0) {
            console.log("Found no documents");
            notifier.statusBarItem.hide();
            return;
        }

        const definitions: CssClassDefinition[] = [];

        pushProto.apply(definitions, await ParseEngineGateway.callParser(uris[0]));

        uniqueDefinitions = _.uniqBy(definitions, (def) => def.className);

        console.log("Summary:");
        console.log(definitions.length, "CSS class definitions found");
        console.log(uniqueDefinitions.length, "unique CSS class definitions found");

        notifier.notify("zap", "CSS classes cached (click to cache again)");
    } catch (err) {
        notifier.notify("alert", "Failed to cache the CSS classes in the workspace (click for another attempt)");
        throw new VError(err,
            "Failed to cache the class definitions during the iterations over the documents that were found");
    }
}

async function cacheCurrentEditor(uri: Uri): Promise<void> {
    const definitions: CssClassDefinition[] = [];
    curFileDefinitions = []; // reset

    pushProto.apply(definitions, await ParseEngineGateway.callParser(uri));
    curFileDefinitions = _.uniqBy(definitions, (def) => def.className);
    console.log(curFileDefinitions.length, "unique CSS class definitions found");
    console.log("finish parsed:", uri.path);
}

function provideCompletionItemsGenerator(languageSelector: string, classMatchRegex: RegExp,
                                         classPrefix: string = "", splitChar: string = " ") {
    return languages.registerCompletionItemProvider({ scheme: "file", language: languageSelector}, {
        provideCompletionItems(document: TextDocument, position: Position): CompletionItem[] {
            const start: Position = new Position(position.line, 0);
            const range: Range = new Range(start, position);
            const text: string = document.getText(range);
 
            // Check if the cursor is on a class attribute and retrieve all the css rules in this class attribute
            const rawClasses: RegExpMatchArray = text.match(classMatchRegex);
            if (!rawClasses || rawClasses.length === 1) {
                return [];
            }

            // Will store the classes found on the class attribute
            const classesOnAttribute = rawClasses[1].split(splitChar);

            // Creates a collection of CompletionItem based on the classes already cached
            const completionItems = uniqueDefinitions.concat(curFileDefinitions).map((definition) => {
                const completionItem = new CompletionItem(definition.className, CompletionItemKind.Variable);
                const completionClassName = `${classPrefix}${definition.className}`;

                completionItem.filterText = completionClassName;
                completionItem.insertText = completionClassName;

                return completionItem;
            });

            // Removes from the collection the classes already specified on the class attribute
            for (const classOnAttribute of classesOnAttribute) {
                for (let j = 0; j < completionItems.length; j++) {
                    if (completionItems[j].insertText === classOnAttribute) {
                        completionItems.splice(j, 1);
                    }
                }
            }

            return completionItems;
        },
    }, ...completionTriggerChars);
}

export async function activate(context: ExtensionContext): Promise<void> {
    const disposables: Disposable[] = [];

    context.subscriptions.push(...disposables);

    context.subscriptions.push(commands.registerCommand("smapp.cache", async () => {
        if (caching) {
            return;
        }

        caching = true;
        try {
            await cache();
        } catch (err) {
            err = new VError(err, "Failed to cache the CSS classes in the workspace");
            console.error(err);
            window.showErrorMessage(err.message);
        } finally {
            caching = false;
        }
    }));

    function detectActiveTextEditor(editor: TextEditor): void {
        const fileName: string = editor.document.fileName;
        const isWXMLFile: Boolean = fileName.endsWith(".wxml");

        if (isWXMLFile) {
            const curUri: Uri = URI.file(fileName.replace(".wxml", ".wxss"));
            cacheCurrentEditor(curUri);
        }

        if (isWXMLFile || fileName.endsWith(".js")) {
            const uri: Uri = URI.file(fileName.replace(".wxml", ".js"));
            saveJSFileToken(uri);
        }
    }

    if (window.activeTextEditor) {
        detectActiveTextEditor(window.activeTextEditor);
    }

    window.onDidChangeActiveTextEditor(detectActiveTextEditor, null, disposables);

    // HTML based extensions
    context.subscriptions.push(provideCompletionItemsGenerator("html", /class=["|']([\w- ]*$)/));

    // definition provider
    context.subscriptions.push(languages.registerDefinitionProvider({
        language: "javascript",
        scheme: "file",
    }, {
        provideDefinition(document: TextDocument, position: Position): Definition {
            const fileName: string = document.fileName;
            const start: Position = new Position(position.line, 0);
            const word: string = document.getText(document.getWordRangeAtPosition(position));
            const text: string = document.getText(new Range(start, position));
            const hint: boolean = /this\.\w+/.test(text);

            if (!fileName.endsWith(".js") || !hint) {
                return null;
            }

            if (!jsFileDefinitions.has(document.fileName)) {
                return null;
            }

            const definitions = jsFileDefinitions.get(document.fileName)

            for (let i = 0; i < definitions.length; i++) {
                let item = definitions[i];
                if (item.value === word) {
                    let prev = definitions[i - 1];
                    
                    if (prev.type == 'Punctuator' && prev.value === ',') {
                        const pos = item.loc.start;
                        return new Location(document.uri, new Position(pos.line - 1, pos.column));
                    }
                }
            }
        },
    }));

    caching = true;
    try {
        await cache();
    } catch (err) {
        err = new VError(err, "Failed to cache the CSS classes in the workspace for the first time");
        console.error(err);
        window.showErrorMessage(err.message);
    } finally {
        caching = false;
    }
}

export function deactivate(): void {
    // empty
}

function saveJSFileToken(uri: Uri) {
    let hasCache = jsFileDefinitions.has(uri.path);
    if (hasCache) return;

    let ct = fs.readFileSync(uri.path, { encoding: 'utf-8'});
    let identifiers = esprima.tokenize(ct, { loc: true })
    // let identifiers = res.filter((item: any) => item.type === 'Identifier');
    
    jsFileDefinitions.set(uri.path, identifiers);
    console.log(`finish cache file:${uri.path}`);
}
