# 小さな JSON の読み書き（Lectoryx の連携ツールを標準ライブラリだけで動かすため）
module MiniJSON

export parse_json, json, RawJSON

"""すでに JSON になっている文字列をそのまま埋め込むための包み"""
struct RawJSON
    s::String
end

# ---------------------------------------------------------------- 書き出し
function writestr(io::IO, s::AbstractString)
    print(io, '"')
    for c in s
        if c == '"'
            print(io, "\\\"")
        elseif c == '\\'
            print(io, "\\\\")
        elseif c == '\n'
            print(io, "\\n")
        elseif c == '\r'
            print(io, "\\r")
        elseif c == '\t'
            print(io, "\\t")
        elseif c < ' ' || c == ' ' || c == ' '
            print(io, "\\u", string(UInt16(c), base=16, pad=4))
        elseif !isvalid(c)
            print(io, "\\ufffd")
        else
            print(io, c)
        end
    end
    print(io, '"')
end

writejson(io::IO, ::Nothing) = print(io, "null")
writejson(io::IO, x::Bool) = print(io, x ? "true" : "false")
writejson(io::IO, x::Integer) = print(io, x)
writejson(io::IO, x::AbstractFloat) = isfinite(x) ? print(io, repr(Float64(x))) : print(io, "null")
writejson(io::IO, x::AbstractString) = writestr(io, x)
writejson(io::IO, x::Symbol) = writestr(io, String(x))
writejson(io::IO, x::RawJSON) = print(io, x.s)
function writejson(io::IO, x::AbstractDict)
    print(io, '{')
    first = true
    for (k, v) in x
        first || print(io, ',')
        first = false
        writestr(io, string(k))
        print(io, ':')
        writejson(io, v)
    end
    print(io, '}')
end
writejson(io::IO, x::NamedTuple) = writejson(io, Dict{String,Any}(string(k) => v for (k, v) in pairs(x)))
function writejson(io::IO, x::Union{AbstractVector,Tuple})
    print(io, '[')
    for (i, v) in enumerate(x)
        i > 1 && print(io, ',')
        writejson(io, v)
    end
    print(io, ']')
end
writejson(io::IO, x) = writestr(io, string(x))

json(x) = sprint(writejson, x)

# ---------------------------------------------------------------- 読み込み
mutable struct Reader
    s::Vector{UInt8}
    i::Int
end

@inline peek(r::Reader) = r.i <= length(r.s) ? r.s[r.i] : 0x00
function skipws(r::Reader)
    while r.i <= length(r.s) && r.s[r.i] in (0x20, 0x09, 0x0a, 0x0d)
        r.i += 1
    end
end
bad(r::Reader, msg) = throw(ArgumentError("JSON の形式が正しくありません（$(r.i) 文字目付近）: $msg"))

function parse_json(s::AbstractString)
    r = Reader(Vector{UInt8}(codeunits(String(s))), 1)
    skipws(r)
    v = readvalue(r, 0)
    skipws(r)
    r.i <= length(r.s) && bad(r, "余分な文字")
    return v
end

function readvalue(r::Reader, depth::Int)
    depth > 64 && bad(r, "入れ子が深すぎます")
    c = peek(r)
    if c == UInt8('{')
        r.i += 1
        d = Dict{String,Any}()
        skipws(r)
        if peek(r) == UInt8('}')
            r.i += 1
            return d
        end
        while true
            skipws(r)
            peek(r) == UInt8('"') || bad(r, "キーは文字列")
            k = readstring(r)
            skipws(r)
            peek(r) == UInt8(':') || bad(r, "':' がありません")
            r.i += 1
            skipws(r)
            d[k] = readvalue(r, depth + 1)
            skipws(r)
            c = peek(r)
            r.i += 1
            c == UInt8('}') && return d
            c == UInt8(',') || bad(r, "',' か '}' がありません")
        end
    elseif c == UInt8('[')
        r.i += 1
        a = Any[]
        skipws(r)
        if peek(r) == UInt8(']')
            r.i += 1
            return a
        end
        while true
            skipws(r)
            push!(a, readvalue(r, depth + 1))
            skipws(r)
            c = peek(r)
            r.i += 1
            c == UInt8(']') && return a
            c == UInt8(',') || bad(r, "',' か ']' がありません")
        end
    elseif c == UInt8('"')
        return readstring(r)
    elseif c == UInt8('t')
        literal(r, "true")
        return true
    elseif c == UInt8('f')
        literal(r, "false")
        return false
    elseif c == UInt8('n')
        literal(r, "null")
        return nothing
    else
        return readnumber(r)
    end
end

function literal(r::Reader, word::String)
    n = ncodeunits(word)
    r.i + n - 1 <= length(r.s) && String(r.s[r.i:r.i+n-1]) == word || bad(r, "不明な値")
    r.i += n
end

function readnumber(r::Reader)
    start = r.i
    isfloat = false
    while r.i <= length(r.s)
        c = r.s[r.i]
        if c in UInt8('0'):UInt8('9') || c == UInt8('-') || c == UInt8('+')
        elseif c == UInt8('.') || c == UInt8('e') || c == UInt8('E')
            isfloat = true
        else
            break
        end
        r.i += 1
    end
    t = String(r.s[start:r.i-1])
    isempty(t) && bad(r, "値がありません")
    if !isfloat
        v = tryparse(Int64, t)
        v === nothing || return v
    end
    v = tryparse(Float64, t)
    v === nothing && bad(r, "数値: $t")
    return v
end

function hex4(r::Reader)
    r.i + 3 <= length(r.s) || bad(r, "\\u の後が短い")
    v = parse(UInt16, String(r.s[r.i:r.i+3]), base=16)
    r.i += 4
    return v
end

function readstring(r::Reader)
    r.i += 1   # "
    io = IOBuffer()
    while true
        r.i > length(r.s) && bad(r, "文字列が閉じていません")
        c = r.s[r.i]
        if c == UInt8('"')
            r.i += 1
            return String(take!(io))
        elseif c == UInt8('\\')
            r.i += 1
            e = peek(r)
            r.i += 1
            if e == UInt8('n'); write(io, '\n')
            elseif e == UInt8('t'); write(io, '\t')
            elseif e == UInt8('r'); write(io, '\r')
            elseif e == UInt8('b'); write(io, '\b')
            elseif e == UInt8('f'); write(io, '\f')
            elseif e == UInt8('/'); write(io, '/')
            elseif e == UInt8('\\'); write(io, '\\')
            elseif e == UInt8('"'); write(io, '"')
            elseif e == UInt8('u')
                u = hex4(r)
                if 0xd800 <= u <= 0xdbff && peek(r) == UInt8('\\') && r.i + 1 <= length(r.s) && r.s[r.i+1] == UInt8('u')
                    r.i += 2
                    l = hex4(r)
                    write(io, Char(0x10000 + ((UInt32(u) - 0xd800) << 10) + (UInt32(l) - 0xdc00)))
                else
                    write(io, Char(u))
                end
            else
                bad(r, "不明なエスケープ")
            end
        else
            write(io, c)
            r.i += 1
        end
    end
end

end # module
