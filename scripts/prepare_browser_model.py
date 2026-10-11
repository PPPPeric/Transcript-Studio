"""Remove unused encoder attention graph outputs, preserving ONNX weights verbatim.

ONNX is protobuf: ModelProto.graph is field 7, GraphProto.output is field 12,
and ValueInfoProto.name is field 1. No Python ML dependencies are required.
"""
import mmap
from pathlib import Path
import sys


def varint(data, position):
    value = shift = 0
    while True:
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
        shift += 7


def encoded(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return result


def fields(data, start, end):
    position = start
    while position < end:
        beginning = position
        tag, position = varint(data, position)
        wire = tag & 7
        if wire == 2:
            length, position = varint(data, position)
            payload = position
            position += length
        elif wire == 0:
            payload = position
            _, position = varint(data, position)
        elif wire in (1, 5):
            payload = position
            position += 8 if wire == 1 else 4
        else:
            raise ValueError(f'Unsupported protobuf wire type: {wire}')
        if position > end:
            raise ValueError('Truncated ONNX protobuf')
        yield tag >> 3, beginning, payload, position


def prepare(path):
    path = Path(path)
    with path.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
        graph = next(field for field in fields(data, 0, len(data)) if field[0] == 7)
        _, beginning, start, end = graph
        entries = list(fields(data, start, end))
        removed = []
        for number, a, b, c in entries:
            if number == 12:
                names = [data[y:z] for key, _, y, z in fields(data, b, c) if key == 1]
                if any(name.startswith(b'encoder_attentions.') for name in names):
                    removed.append((a, c))
        if not removed:
            return
        temporary = path.with_suffix('.prepared')
        with temporary.open('wb') as target:
            view = memoryview(data)
            target.write(view[:beginning])
            target.write(encoded((7 << 3) | 2))
            target.write(encoded(end - start - sum(c - a for a, c in removed)))
            cursor = start
            for a, c in removed:
                target.write(view[cursor:a])
                cursor = c
            target.write(view[cursor:])
            view.release()
    temporary.replace(path)
    print(f'Removed {len(removed)} unused encoder attention outputs: {path}', flush=True)


if __name__ == '__main__':
    prepare(sys.argv[1])
