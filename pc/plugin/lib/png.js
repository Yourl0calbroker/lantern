import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunkText(type, data) {
    if (type === 'tEXt') {
        const separator = data.indexOf(0);
        if (separator < 1) {
            return null;
        }
        return [data.subarray(0, separator).toString('latin1'), data.subarray(separator + 1).toString('latin1')];
    }

    if (type === 'zTXt') {
        const separator = data.indexOf(0);
        if (separator < 1) {
            return null;
        }
        const keyword = data.subarray(0, separator).toString('latin1');
        const compressed = data.subarray(separator + 2);
        try {
            return [keyword, zlib.inflateSync(compressed).toString('latin1')];
        } catch {
            return null;
        }
    }

    if (type === 'iTXt') {
        const keywordEnd = data.indexOf(0);
        if (keywordEnd < 1) {
            return null;
        }
        const keyword = data.subarray(0, keywordEnd).toString('latin1');
        const compressionFlag = data[keywordEnd + 1];
        let cursor = keywordEnd + 3;
        const languageEnd = data.indexOf(0, cursor);
        if (languageEnd < 0) {
            return null;
        }
        cursor = languageEnd + 1;
        const translatedEnd = data.indexOf(0, cursor);
        if (translatedEnd < 0) {
            return null;
        }
        const text = data.subarray(translatedEnd + 1);
        try {
            return [keyword, compressionFlag === 1 ? zlib.inflateSync(text).toString('utf8') : text.toString('utf8')];
        } catch {
            return null;
        }
    }

    return null;
}

export async function readPngTextChunks(file) {
    const buffer = await fsp.readFile(file);
    if (buffer.length < SIGNATURE.length || !buffer.subarray(0, 8).equals(SIGNATURE)) {
        return new Map();
    }

    const chunks = new Map();
    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) {
            break;
        }
        if (type === 'IEND') {
            break;
        }
        const entry = readChunkText(type, buffer.subarray(dataStart, dataEnd));
        if (entry && !chunks.has(entry[0])) {
            chunks.set(entry[0], entry[1]);
        }
        offset = dataEnd + 4;
    }

    return chunks;
}

export function decodeCardPayload(text) {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

export async function readCardFromPng(file) {
    const chunks = await readPngTextChunks(file);
    return decodeCardPayload(chunks.get('ccv3')) ?? decodeCardPayload(chunks.get('chara'));
}
