"use strict";

export interface IPosition {
    line: number;
    column: number;
}

export interface ILocation {
    start: IPosition;
}

class JSDefinition {
    public constructor(public value: string, public loc: ILocation) { }
}

export default JSDefinition;
