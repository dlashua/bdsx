import { abstract, Bufferable, emptyFunc, Encoding, TypeFromEncoding } from "./common";
import { NativePointer, PrivatePointer, StaticPointer, StructurePointer, VoidPointer } from "./core";
import { makefunc } from "./makefunc";
import { NativeDescriptorBuilder, NativeType, Type } from "./nativetype";
import { Singleton } from "./singleton";

type FieldMapItem = [Type<any>, number]|Type<any>;


export type KeysWithoutFunction<T> = {[key in keyof T]:T[key] extends (...args:any[])=>any ? never: key}[keyof T];

type StructureFields<T> = {[key in KeysWithoutFunction<T>]?:Type<T[key]>|[Type<T[key]>, number]};

const isNativeClass = Symbol();
const isInherited = Symbol();
const offsetmap = Symbol();

function accessor(key:string|number):string {
    if (typeof key === 'number') return `[${key}]`;
    if (/^[a-zA-Z_$][a-zA-Z_$]*$/.test(key)) return `.${key}`;
    return `[${JSON.stringify(key)}]`;
}

export interface NativeClassType<T extends NativeClass> extends Type<T>
{
    new():T;
    prototype:T;
    [StructurePointer.contentSize]:number|null;
    [offsetmap]:Record<string, number>;
    define(fields:StructureFields<T>, defineSize?:number|null, defineAlign?:number|null, abstract?:boolean):void;
    offsetOf(key:KeysWithoutFunction<T>):number;
}

export class NativeClass extends StructurePointer {
    static readonly [NativeType.size]:number = 0;
    static readonly [NativeType.align]:number = 1;
    static [StructurePointer.contentSize]:number = 0;
    static readonly [isNativeClass] = true;
    static readonly [isInherited] = true;
    static [offsetmap]:Record<string,number>;

    static isNativeClassType(type:Record<string, any>):type is typeof NativeClass {
        return isNativeClass in type;
    }

    constructor(ptr?:VoidPointer|boolean) {
        super(ptr);
    }

    [NativeType.size]:number;

    [NativeType.ctor]():void {
        // empty
    }
    [NativeType.dtor]():void {
        // empty
    }
    private _default_copy(from:NativeClass):void {
        this.copyFrom(from, this[NativeType.size]);
    }
    [NativeType.ctor_copy](from:NativeClass):void {
        this._default_copy(from);
    }
    [NativeType.ctor_move](from:NativeClass):void {
        this[NativeType.ctor_copy](from);
    }
    [NativeType.setter](from:NativeClass):void {
        this[NativeType.dtor]();
        this[NativeType.ctor_copy](from);
    }
    static [NativeType.ctor](ptr:StaticPointer):void {
        ptr.as(this)[NativeType.ctor]();
    }
    static [NativeType.dtor](ptr:StaticPointer):void {
        ptr.as(this)[NativeType.dtor]();
    }
    static [NativeType.ctor_copy](to:StaticPointer, from:StaticPointer):void {
        to.as(this)[NativeType.ctor_copy](new this(from));
    }
    static [NativeType.ctor_move](to:StaticPointer, from:StaticPointer):void {
        to.as(this)[NativeType.ctor_move](new this(from));
    }
    static [NativeType.setter]<THIS extends VoidPointer>(this:{new():THIS}, ptr:VoidPointer, value:THIS, offset?:number):void {
        const nptr = ptr.addAs(this, offset, (offset || 0) >> 31);
        (nptr as any)[NativeType.setter](value as any);
    }
    static [NativeType.getter]<THIS extends VoidPointer>(this:{new():THIS}, ptr:VoidPointer, offset?:number):THIS {
        return ptr.addAs(this, offset, (offset || 0) >> 31);
    }
    static [NativeType.descriptor](builder:NativeDescriptorBuilder, key:string|number, offset:number):void {
        const type = this;
        builder.desc[key] = {
            configurable: true,
            get(this:VoidPointer) {
                const value = type[NativeType.getter](this, offset);
                Object.defineProperty(this, key, {value});
                return value;
            }
        };
        if (type[NativeType.ctor] !== emptyFunc) {
            builder.ctor.code += `this${accessor(key)}[NativeType.ctor]();\n`;
        }
        if (type[NativeType.dtor] !== emptyFunc) {
            builder.dtor.code += `this${accessor(key)}[NativeType.dtor]();\n`;
        }
        builder.ctor_copy.code += `this${accessor(key)}[NativeType.ctor_copy](o${accessor(key)});\n`;
    }

    /**
     * alias of [NativeType.ctor]();
     */
    construct():void {
        this[NativeType.ctor]();
    }

    /**
     * alias of [NativeType.dtor]();
     */
    destruct():void {
        this[NativeType.dtor]();
    }

    static next<T extends NativeClass>(this:{new():T}, ptr:T, count:number):T {
        const clazz = this as NativeClassType<T>;
        const size = clazz[StructurePointer.contentSize];
        if (size === null) {
            throw Error('Cannot call the next with the unknown sized structure');
        }
        return ptr.addAs(this, count * size) as any;
    }
    /**
     * Cannot construct & Unknown size
     */
    static abstract<T extends NativeClass>(this:{new():T}, fields:StructureFields<T>, defineSize?:number, defineAlign?:number|null):void {
        const clazz = this as NativeClassType<T>;
        clazz.define(fields, defineSize, defineAlign, true);
    }

    static define<T extends NativeClass>(this:{new():T}, fields:StructureFields<T>, defineSize?:number|null, defineAlign?:number|null, abstract:boolean=false):void {
        const clazz = this as NativeClassType<T>;
        if (makefunc.np2js in clazz) {
            clazz[NativeType.getter] = wrapperGetter;
            clazz[NativeType.descriptor] = wrapperDescriptor;
        }

        if (this.hasOwnProperty(isInherited)) {
            throw Error('Cannot define structure of already inherited NativeClass');
        }

        const proto = (this as any).__proto__;
        {
            let node = proto;
            while (!node.hasOwnProperty(isInherited)) {
                node[isInherited] = true;
                node = node.__proto__;
            }
        }
        let offset:number|null = proto[NativeType.size];
        let size = offset;
        let align:number = defineAlign != null ? defineAlign : proto[NativeType.align];

        const offmap:Record<string, number> = clazz[offsetmap] = {};
        
        const propmap = new NativeDescriptorBuilder;
        for (const key in fields) {
            let type:FieldMapItem = fields[key as KeysWithoutFunction<T>]!;
            let forceOffset = false;
            if (type instanceof Array) {
                offset = type[1];
                type = type[0];
                forceOffset = true;
            }
            if (offset === null) throw Error('Cannot set fields without offset when extends abstract class');
            const alignofType = type[NativeType.align];
            if (!forceOffset) offset = (((offset + alignofType - 1) / alignofType)|0)*alignofType;
            offmap[key] = offset;

            type[NativeType.descriptor](propmap, key, offset);
            const sizeofType = type[NativeType.size];
            if (defineAlign == null && alignofType > align) align = alignofType;

            if (sizeofType === null) offset = null;
            else offset += sizeofType;

            if (size !== null) {
                if (offset !== null && offset > size) size = offset;
            }
        }

        const types = propmap.types;
        if (propmap.ctor.code !== '') {
            const ctorfunc = new Function('NativeType', 'types', propmap.ctor.code);
            const superCtor = clazz.prototype[NativeType.ctor];
            clazz.prototype[NativeType.ctor] = function(this:T){ 
                ctorfunc.call(this, NativeType, types);
                superCtor.call(this);
            };
        }
        if (propmap.dtor.code !== '') {
            const dtorfunc = new Function('NativeType', 'types', propmap.dtor.code);
            const superDtor = clazz.prototype[NativeType.dtor];
            clazz.prototype[NativeType.dtor] = function(this:T){ 
                dtorfunc.call(this, NativeType, types);
                superDtor.call(this);
            };
        }
        if (propmap.ctor_copy.code !== '') {
            const copyfunc = new Function('NativeType', 'types', 'o', propmap.ctor_copy.code);
            clazz.prototype._default_copy = function(this:T, o:T){ 
                copyfunc.call(this, NativeType, types, o);
            };
        }
        clazz[StructurePointer.contentSize] = 
        this.prototype[NativeType.size] = 
        clazz[NativeType.size] = (defineSize != null ? defineSize : abstract ? null : size)!;
        clazz[NativeType.align] = align;
        
        Object.defineProperties(this.prototype, propmap.desc);
    }

    static defineAsUnion<T extends NativeClass>(this:{new():T}, fields:StructureFields<T>, abstract:boolean = false):void {
        const clazz = this as NativeClassType<T>;
        for (const key in fields) {
            const item:FieldMapItem = fields[key as KeysWithoutFunction<T>]!;
            if (!(item instanceof Array)) {
                fields[key as KeysWithoutFunction<T>] = [item, 0];
            }
        }
        return clazz.define(fields, null, null, abstract);
    }

    static ref<T extends NativeClass>(this:{new():T}):NativeClassType<T> {
        return refSingleton.newInstance(this, ()=>makeReference(this));
    }

    static offsetOf<T>(this:{new():T}, field:KeysWithoutFunction<T>|symbol):number {
        return (this as any)[offsetmap][field]!;
    }
}
NativeClass.prototype[NativeType.size] = 0;

function wrapperGetter<THIS extends VoidPointer>(this:{new():THIS}, ptr:StaticPointer, offset?:number):THIS{
    return (this as any)[makefunc.np2js](ptr.addAs(this, offset));
}
function wrapperGetterRef<THIS extends VoidPointer>(this:{new():THIS}, ptr:StaticPointer, offset?:number):THIS{
    return (this as any)[makefunc.np2js](ptr.getNullablePointerAs(this, offset));
}
function wrapperSetterRef<THIS extends VoidPointer>(this:{new():THIS}, ptr:StaticPointer, value:THIS, offset?:number):void{
    ptr.setPointer((this as any)[makefunc.js2np](value), offset);
}
function wrapperDescriptor<THIS extends NativeClass>(this:{new():THIS}, builder:NativeDescriptorBuilder, key:string|number, offset:number):void {
    const clazz = this as NativeClassType<THIS>;
    builder.desc[key] = {
        configurable: true,
        get(this:VoidPointer) {
            const value = (clazz as any)[makefunc.np2js](this.addAs(clazz, offset));
            Object.defineProperty(this, key, {value});
            return value;
        }
    };
    if (clazz[NativeType.ctor] !== emptyFunc) {
        builder.ctor.code += `this${accessor(key)}[NativeType.ctor]();\n`;
    }
    if (clazz[NativeType.dtor] !== emptyFunc) {
        builder.dtor.code += `this${accessor(key)}[NativeType.dtor]();\n`;
    }
    builder.ctor_copy.code += `this${accessor(key)}[NativeType.ctor_copy](o${accessor(key)});\n`;
}

const refSingleton = new Singleton<NativeClassType<any>>();

export interface NativeArrayType<T> extends Type<NativeArray<T>>
{
    new(ptr?:VoidPointer):NativeArray<T>;
}

export class NativeArray<T> extends PrivatePointer {
    [index:number]:T;

    static [NativeType.getter]<THIS extends VoidPointer>(this:{new():THIS}, ptr:StaticPointer, offset?:number):THIS {
        return ptr.addAs(this, offset, offset! >> 31);
    }
    static [NativeType.setter]<THIS extends VoidPointer>(this:{new():THIS}, ptr:StaticPointer, value:THIS, offset?:number):void {
        throw Error("non assignable");
    }
    static [NativeType.descriptor](builder:NativeDescriptorBuilder, key:string|number, offset:number):void {
        const type = this;
        builder.desc[key] = {
            configurable: true,
            get(this:VoidPointer) {
                const value = this.addAs(type, offset, offset >> 31);
                Object.defineProperty(this, key, {value});
                return value;
            }
        };
        if (type[NativeType.ctor] !== emptyFunc) {
            builder.ctor.code += `this${accessor(key)}[NativeType.ctor]();\n`;
        }
        if (type[NativeType.dtor] !== emptyFunc) {
            builder.dtor.code += `this${accessor(key)}[NativeType.dtor]();\n`;
        }
        builder.ctor_copy.code += `this${accessor(key)}[NativeType.ctor_copy](o${accessor(key)});\n`;
    }
    static readonly [NativeType.align]:number = 1;

    static make<T>(itemType:Type<T>, count:number):NativeArrayType<T> {
        const itemSize = itemType[NativeType.size];
        if (itemSize === null) throw Error('Unknown size of item. NativeArray needs item size');

        const propmap = new NativeDescriptorBuilder;
        propmap.desc.length = {value: count};
        
        let off = 0;
        for (let i = 0; i < count; i++) {
            itemType[NativeType.descriptor](propmap, i, off);
            off += itemSize;
        }
        class NativeArrayImpl extends NativeArray<T> {
            static readonly [NativeType.size] = off;
            static readonly [StructurePointer.contentSize] = off;
            static readonly [NativeType.align] = itemType[NativeType.align];
            [NativeType.size]:number;
        }
        NativeArrayImpl.prototype[NativeType.size] = off;

        Object.defineProperties(NativeArrayImpl.prototype, propmap.desc);
        return NativeArrayImpl;
    }
}


export declare class MantleClass extends NativeClass {
    getBoolean(offset?: number): boolean;
    getUint8(offset?: number): number;
    getUint16(offset?: number): number;
    getUint32(offset?: number): number;
    getUint64AsFloat(offset?: number): number;
    getInt8(offset?: number): number;
    getInt16(offset?: number): number;
    getInt32(offset?: number): number;
    getInt64AsFloat(offset?: number): number;
    getFloat32(offset?: number): number;
    getFloat64(offset?: number): number;
    getNullablePointer(offset?: number): NativePointer|null;
    getNullablePointerAs<T extends VoidPointer>(ctor:{new():T}, offset?: number): T|null;
    getPointer(offset?: number): NativePointer;
    getPointerAs<T extends VoidPointer>(ctor:{new():T}, offset?: number): T;

    fill(bytevalue:number, bytes:number, offset?: number): void;
    copyFrom(from: VoidPointer, bytes:number, this_offset?: number, from_offset?:number): void;
    setBoolean(value: boolean, offset?: number): void;
    setUint8(value: number, offset?: number): void;
    setUint16(value: number, offset?: number): void;
    setUint32(value: number, offset?: number): void;
    setUint64WithFloat(value: number, offset?: number): void;
    setInt8(value: number, offset?: number): void;
    setInt16(value: number, offset?: number): void;
    setInt32(value: number, offset?: number): void;
    setInt64WithFloat(value: number, offset?: number): void;
    setFloat32(value: number, offset?: number): void;
    setFloat64(value: number, offset?: number): void;
    setPointer(value: VoidPointer|null, offset?: number): void;

    /**
     * get C++ std::string
     * @param encoding default = Encoding.Utf8
     */
    getCxxString<T extends Encoding = Encoding.Utf8>(offset?: number, encoding?: T): TypeFromEncoding<T>;

    /**
     * set C++ std::string
     * Need to target pointer to string
     * It will call string::assign method to pointer
     * @param encoding default = Encoding.Utf8
     */
    setCxxString(str: string | Bufferable, offset?: number, encoding?: Encoding): void;

    /**
     * get string
     * @param bytes if it's not provided, It will read until reach null character
     * @param encoding default = Encoding.Utf8
     * if encoding is Encoding.Buffer it will call getBuffer
     * if encoding is Encoding.Utf16, bytes will be twice
     */
    getString<T extends Encoding = Encoding.Utf8>(bytes?: number, offset?: number, encoding?: T): TypeFromEncoding<T>;

    /**
     * set string with null character
     * @param encoding default = Encoding.Utf8
     * @return writed bytes without null character
     * if encoding is Encoding.Buffer it will call setBuffer
     * if encoding is Encoding.Utf16, bytes will be twice
     */
    setString(text: string, offset?: number, encoding?: Encoding): number;

    getBuffer(bytes: number, offset?: number): Uint8Array;

    setBuffer(buffer: Bufferable, offset?: number): void;
    
    /**
     * Read memory as binary string.
     * It stores 2bytes per character
     * @param words 2bytes per word
     */
    getBin(words: number, offset?:number): string;

    /**
     * is same with getBin(4).
     * It stores 2bytes per character for 64bits.
     */
    getBin64(offset?:number): string;

    /**
     * Write memory with binary string.
     * It reads 2bytes per character
     * @param words 2bytes per word
     */
    setBin(v:string, offset?:number): void;
    
    interlockedIncrement16(offset?:number):number;
    interlockedIncrement32(offset?:number):number;
    interlockedIncrement64(offset?:number):number;
    interlockedDecrement16(offset?:number):number;
    interlockedDecrement32(offset?:number):number;
    interlockedDecrement64(offset?:number):number;
    interlockedCompareExchange8(exchange:number, compare:number, offset?:number):number;
    interlockedCompareExchange16(exchange:number, compare:number, offset?:number):number;
    interlockedCompareExchange32(exchange:number, compare:number, offset?:number):number;
    interlockedCompareExchange64(exchange:string, compare:string, offset?:number):string;
    
    getJsValueRef(offset?:number):any;
    setJsValueRef(value:unknown, offset?:number):void;
}
exports.MantleClass = NativeClass;

function makeReference<T extends NativeClass>(type:{new():T}):NativeClassType<T> {
    const Parent:{new():NativeClass} = type;
    class Pointer extends Parent {
        static readonly [NativeType.size] = 8;
        static readonly [NativeType.align] = 8;
        static readonly [StructurePointer.contentSize]:number;

        constructor() {
            super();
        }

        static [NativeType.getter](ptr:StaticPointer, offset?:number):T|null {
            return ptr.getNullablePointerAs(this, offset) as unknown as T;
        }
        static [NativeType.setter](ptr:StaticPointer, value:T, offset?:number):void {
            ptr.setPointer(value, offset);
        }
        static [NativeType.ctor]():void {
            // empty
        }
        static [NativeType.dtor]():void {
            // empty
        }
        static [NativeType.ctor_copy](ptr:StaticPointer, from:VoidPointer):void {
            ptr.copyFrom(from, 8);
        }
        static [NativeType.ctor_move](ptr:StaticPointer, from:VoidPointer):void {
            this[NativeType.ctor_copy](ptr, from);
        }
        static [NativeType.descriptor](builder:NativeDescriptorBuilder, key:string, offset:number):void {
            abstract();
        }

        static define():void {
            throw Error('Wrong call, does not need to define structure of pointer class');
        }
    }
    Pointer[NativeType.descriptor] = NativeType.defaultDescriptor;
    
    if (makefunc.np2js in type) Pointer[NativeType.getter] = wrapperGetterRef as any;
    if (makefunc.js2np in type) Pointer[NativeType.setter] = wrapperSetterRef;
    return Pointer as Type<T> as NativeClassType<T>;
}
