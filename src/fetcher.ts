import * as vscode from "vscode";
import { GlobPattern } from "vscode";
import ParseEngineRegistry from "./parse-engines/parse-engine-registry";

class Fetcher {
    public static async findAllParseableDocuments(glob: GlobPattern): Promise<vscode.Uri[]> {

        if (!vscode.workspace.name) {
            return [];
        }

        return await vscode.workspace.findFiles(glob);
    }
}

export default Fetcher;
