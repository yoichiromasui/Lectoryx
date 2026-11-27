# 値を、採点用の共通形式（experiments/julia-wasm/julia/value.js と同じ）の JSON 文字列にする。
# 連携ツールのワーカーが実行結果の値を返すときに使う（SubsetJuliaVM の試作と同じ形式。外部パッケージは使わない）。
module JLValue

export tojson

function jstr(s::AbstractString)
    io = IOBuffer()
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
        elseif c < ' '
            print(io, "\\u", string(UInt16(c), base=16, pad=4))
        else
            print(io, c)
        end
    end
    print(io, '"')
    return String(take!(io))
end

jt(x) = jstr(string(typeof(x)))

function jnum(x::Real)
    if x isa Integer
        return abs(x) <= 2^53 ? string(Int64(x)) : jstr(string(x))
    end
    f = Float64(x)
    isnan(f) && return "\"NaN\""
    isinf(f) && return f > 0 ? "\"Inf\"" : "\"-Inf\""
    return repr(f)
end

tojson(x::Bool) = "{\"t\":\"bool\",\"v\":$(x ? "true" : "false")}"
tojson(x::Real) = "{\"t\":\"num\",\"v\":$(jnum(x)),\"jt\":$(jt(x))}"
tojson(x::Complex) = "{\"t\":\"complex\",\"re\":$(jnum(real(x))),\"im\":$(jnum(imag(x))),\"jt\":$(jt(x))}"
tojson(x::AbstractString) = "{\"t\":\"str\",\"v\":$(jstr(x)),\"jt\":\"String\"}"
tojson(x::AbstractChar) = "{\"t\":\"str\",\"v\":$(jstr(string(x))),\"jt\":\"Char\"}"
tojson(x::Symbol) = "{\"t\":\"str\",\"v\":$(jstr(string(x))),\"jt\":\"Symbol\"}"
tojson(::Nothing) = "{\"t\":\"nothing\"}"
function tojson(x::AbstractArray)
    a = collect(x)
    shape = join(string.(size(a)), ",")
    data = join((tojson(e) for e in vec(a)), ",")
    t = x isa AbstractRange || !(x isa Array) ? string(typeof(a)) : string(typeof(x))
    return "{\"t\":\"array\",\"shape\":[$shape],\"data\":[$data],\"jt\":$(jstr(t))}"
end
tojson(x::Tuple) = "{\"t\":\"tuple\",\"items\":[$(join((tojson(e) for e in x), ","))]}"
function tojson(x::NamedTuple)
    names = join((jstr(string(k)) for k in keys(x)), ",")
    return "{\"t\":\"tuple\",\"items\":[$(join((tojson(e) for e in values(x)), ","))],\"names\":[$names]}"
end
tojson(x) = "{\"t\":\"other\",\"display\":$(jstr(repr(x))),\"jt\":$(jt(x))}"

end
