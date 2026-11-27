# =============================================================
# LectoryxWorker：連携ツールのワーカー（1 回の実行・採点ごとに使い捨てる Julia プロセス）
#   起動：julia --project=<教材の環境> -e "using LectoryxWorker; LectoryxWorker.main()" <連携ツールの内部ポート>
#   ・標準入力の 1 行目で合言葉を受け取り、連携ツールに TCP（127.0.0.1）で接続する。
#   ・preload（環境のパッケージを読み込むだけ。名前は Main に取り込まない）→ ready
#   ・仕事を 1 つ受け取り（run / tests）、結果を返して終了する。
#   コードは Main で、REPL と同じ規則（ソフトスコープ）で 1 文ずつ評価する。
#   毎回新しいプロセスなので、前の実行の変数・関数・型は残らない。表示も公式の REPL と同じになる。
#   パッケージにしてあるのは、事前コンパイル（pkgimage）で起動を速くするため（標準ライブラリだけに依存）。
# =============================================================
module LectoryxWorker

using Sockets, Base64, Logging
import LinearAlgebra   # ウォームアップ用（Main には取り込まない）

include("MiniJSON.jl")
using .MiniJSON
include("JLValue.jl")
using .JLValue

const SOCK = Ref{TCPSocket}()
const SEND_LOCK = ReentrantLock()
const MAX_OUTPUT = 1_000_000          # 表示する出力の上限（バイト）

send(d) = lock(SEND_LOCK) do
    write(SOCK[], json(d), '\n')
    flush(SOCK[])
end

"""REPL と同じソフトスコープにする（REPL.softscope と同じ。REPL 標準ライブラリの読み込みを省くため）"""
function softscope(@nospecialize ex)
    if ex isa Expr
        h = ex.head
        if h === :toplevel
            ex2 = Expr(h)
            map!(softscope, resize!(ex2.args, length(ex.args)), ex.args)
            return ex2
        elseif h in (:meta, :import, :using, :export, :module, :error, :incomplete, :thunk)
            return ex
        elseif h === :global && all(x -> isa(x, Symbol), ex.args)
            return ex
        else
            return Expr(:block, Expr(:softscope, true), ex)
        end
    end
    return ex
end

# UTF-8 の文字の途中で切れないよう、完全な文字の境目までの長さを返す
function utf8_complete(b::Vector{UInt8})
    n = length(b)
    i = n
    while i > 0 && i > n - 4 && (b[i] & 0xc0) == 0x80
        i -= 1
    end
    i == 0 && return n
    lead = b[i]
    need = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    return n - i + 1 >= need ? n : i - 1
end

safe(f, fallback) = try f() catch; fallback end

"""コードを Main で評価する。出力（stdout・stderr・ログ）をまとめて取り込み、stream_id があれば少しずつ送る"""
function evaluate(code::String; filename::String="main.jl", stream_id=nothing)
    pipe = Pipe()
    Base.link_pipe!(pipe; reader_supports_async=true, writer_supports_async=true)
    captured = IOBuffer()
    truncated = Ref(false)
    reader = @async begin
        pending = UInt8[]
        while !eof(pipe.out)
            data = readavailable(pipe.out)
            room = MAX_OUTPUT - position(captured)
            if room <= 0
                truncated[] = true
                continue
            end
            length(data) > room && (data = data[1:room]; truncated[] = true)
            write(captured, data)
            if stream_id !== nothing
                append!(pending, data)
                k = utf8_complete(pending)
                if k > 0
                    send(Dict("type" => "output", "id" => stream_id, "text" => String(pending[1:k])))
                    pending = pending[k+1:end]
                end
            end
        end
    end
    value = nothing
    err = nothing
    bt = nothing
    t0 = time_ns()
    try
        redirect_stdout(pipe.in) do
            redirect_stderr(pipe.in) do
                with_logger(ConsoleLogger(pipe.in, Logging.Info)) do
                    try
                        value = eval_code(code, filename)
                    catch e
                        err = e
                        bt = catch_backtrace()
                    end
                end
            end
        end
    finally
        close(pipe.in)
        wait(reader)
    end
    ms = (time_ns() - t0) / 1e6
    out = String(take!(captured))
    truncated[] && (out *= "\n…（出力が多すぎるので省略しました）\n")
    res = Dict{String,Any}("ok" => err === nothing, "output" => out, "ms" => round(ms, digits=1))
    if err === nothing
        res["value"] = RawJSON(safe(() -> Base.invokelatest(tojson, value), "{\"t\":\"other\",\"display\":\"（値を変換できません）\"}"))
        res["display"] = display_of(value)
    else
        res["error"] = error_info(err, bt, filename)
    end
    return res
end

function eval_code(code::String, filename::String)
    ex = Meta.parseall(code; filename)
    # 構文エラーがあれば、何も実行せずにそのエラーにする（途中まで実行しない）
    for a in ex.args
        if a isa Expr && (a.head === :error || a.head === :incomplete)
            Core.eval(Main, a)
        end
    end
    value = nothing
    line = LineNumberNode(1, Symbol(filename))
    for a in ex.args
        if a isa LineNumberNode
            line = a
            continue
        end
        value = Core.eval(Main, Expr(:toplevel, line, softscope(a)))
    end
    return value
end

"""REPL と同じ表示（text/plain）と、画像（svg・png）にできるならそのデータ"""
function display_of(value)
    d = Dict{String,Any}()
    value === nothing && return d
    d["text/plain"] = safe(() -> Base.invokelatest(sprint, (io, x) -> show(IOContext(io, :limit => true, :displaysize => (30, 100), :module => Main), MIME"text/plain"(), x), value), "（表示できません）")
    for mime in ("image/svg+xml", "image/png")
        if safe(() -> Base.invokelatest(showable, MIME(mime), value), false)
            data = safe(() -> Base.invokelatest(sprint, (io, x) -> show(io, MIME(mime), x), value), nothing)
            data === nothing && continue
            d[mime] = mime == "image/png" ? base64encode(data) : data
            break
        end
    end
    return d
end

"""エラーの種類・メッセージ・学生のコードの中の行"""
function error_info(err, bt, filename)
    msg = safe(() -> Base.invokelatest(sprint, showerror, err), string(typeof(err)))
    frames = String[]
    line = nothing
    for fr in safe(() -> stacktrace(bt), Base.StackTraces.StackFrame[])
        f = string(fr.file)
        if f == filename || endswith(f, filename)
            line === nothing && (line = fr.line)
            push!(frames, "$(fr.func) at $(filename):$(fr.line)")
        end
    end
    if err isa Base.Meta.ParseError
        m = match(r"@ [^:]+:(\d+):", msg)
        m === nothing || (line = parse(Int, m.captures[1]))
    elseif err isa LoadError
        line = err.line
    end
    return Dict{String,Any}("type" => string(nameof(typeof(err))), "message" => msg, "line" => line, "trace" => frames)
end

# ---------------------------------------------------------------- 連携ツールとのやりとり
function preload(pkgs)
    t0 = time_ns()
    loaded = String[]
    for p in pkgs
        try
            # 読み込むだけ（Main に名前は作らない）。学生のコードの using はすぐ終わる
            m = Base.require(Main, Symbol(p["name"]))
            push!(loaded, p["name"])
            # 教材のウォームアップ（LectoryxEnv._workload）を一度実行して、残りのコンパイルも済ませておく
            if get(p, "workload", false) === true && isdefined(m, :_workload)
                try
                    Base.invokelatest(getfield(m, :_workload))
                catch e
                    msg = first(split(sprint(showerror, e), '\n'))
                    send(Dict("type" => "log", "text" => "教材の warmup.jl の途中でエラー（それより後の呼び出しは速くなりません）: $(first(msg, 200))"))
                end
            end
        catch e
            send(Dict("type" => "log", "text" => "読み込めないパッケージ: $(p["name"])（$(sprint(showerror, e))）"))
        end
    end
    # 数理系の授業でよく使う処理と、評価の道筋を一度通しておく（最初の実行を速くする）
    try
        _workload()
    catch
    end
    evaluate("1 + 1"; filename="warmup.jl")
    return (loaded, (time_ns() - t0) / 1e6)
end

function main(port::Int=parse(Int, ARGS[1]))
    secret = readline(stdin)
    SOCK[] = connect(ip"127.0.0.1", port)
    send(Dict("type" => "hello", "secret" => secret, "pid" => getpid(), "julia" => string(VERSION)))
    while true
        line = readline(SOCK[])
        isempty(line) && eof(SOCK[]) && break
        msg = parse_json(line)
        t = msg["type"]
        if t == "preload"
            loaded, ms = preload(msg["packages"])
            send(Dict("type" => "ready", "loaded" => loaded, "ms" => round(ms, digits=1)))
        elseif t == "run"
            r = evaluate(string(msg["code"]); stream_id=msg["id"])
            r["type"] = "result"
            r["id"] = msg["id"]
            send(r)
            break
        elseif t == "tests"
            id = msg["id"]
            base = evaluate(string(msg["code"]); filename="main.jl")
            base["type"] = "base"
            base["id"] = id
            send(base)
            if base["ok"]
                for (i, tc) in enumerate(msg["tests"])
                    r = evaluate(string(tc["code"]); filename="test.jl")
                    r["type"] = "test"
                    r["id"] = id
                    r["index"] = i
                    send(r)
                end
            end
            send(Dict("type" => "done", "id" => id))
            break
        elseif t == "exit"
            break
        end
    end
end

"""
数理系の授業でよく使う処理（毎回まっさらな Julia で実行するので、何もしないと毎回コンパイルされる：
eigen 1.3 秒・exp(A) 1.1 秒・行列の println 1.3 秒など）。事前コンパイルのときに実行して結果を保存し、
待機中の Julia を用意するときにも一度実行する。Main には何も作らない。
"""
function _workload()
    LA = LinearAlgebra
    A = [0.0 1.0; -2.0 -3.0]
    B = [2.0 1.0; 1.0 3.0]
    b = [1.0, 2.0]
    Ai = [1 2; 3 4]
    F = LA.eigen(A); LA.eigvals(A); LA.eigen(B); LA.eigvals(B); LA.eigvecs(B)
    λ, V = LA.eigen(B)
    vals = Any[exp(A), A^3, A^2, B^-1, LA.inv(B), LA.det(B), B \ b, A * b, A', transpose(A), LA.tr(A), LA.rank(A), LA.norm(b),
               LA.dot(b, b), A - 2.0 * LA.I, A + LA.I, Ai * Ai, Ai^2, LA.det(Ai), LA.inv(Ai), Ai \ [1, 2], λ, V, F.values]
    x = range(0, 1, length=11)
    append!(vals, Any[sin.(x), exp.(-x), collect(x), 1 .- exp.(-x ./ 2.0), [i^2 for i in 1:5], [1 / k for k in 1:4], sum(abs2, b), cumsum(b)])
    z = 1.0 + 2.0im
    append!(vals, Any[abs(z), angle(z), conj(z), sqrt(complex(-1.0)), exp(im * π), [z, 2z], [1 im; -im 1] * [1, im], (1, 2.0), (a = 1, b = 2.0), "s", 1.5, 3, 2 // 3])
    # 学生のコードと同じく、パイプ（stdout を付け替えた先）に表示する
    pipe = Pipe()
    Base.link_pipe!(pipe; reader_supports_async=true, writer_supports_async=true)
    drain = @async read(pipe.out)
    io = pipe.in
    for v in vals
        print(io, v)
        println(io, v)
        show(IOContext(io, :limit => true, :displaysize => (30, 100), :module => Main), MIME"text/plain"(), v)
        println(io, "x = ", v, " $(v)")
        tojson(v)
        display_of(v)
    end
    close(pipe.in)
    wait(drain)
    return nothing
end

if ccall(:jl_generating_output, Cint, ()) == 1
    Base.Experimental.@force_compile
    try
        _workload()
    catch e
        @warn "LectoryxWorker のウォームアップに失敗しました" exception = (e, catch_backtrace())
    end
end

# 学生のコードの表示（stdout を付け替えたパイプへの print・show）。実行時に呼び先が決まる呼び出しは
# ウォームアップだけでは保存されないので、よく使う型の組み合わせを明示する
let PE = Base.PipeEndpoint, IC = IOContext{Base.PipeEndpoint}, TP = MIME"text/plain"
    for T in (Matrix{Float64}, Matrix{Int}, Matrix{ComplexF64}, Vector{Float64}, Vector{Int}, Vector{ComplexF64}, Vector{ComplexF64},
              Vector{Complex{Int}}, LinearAlgebra.Adjoint{Float64,Matrix{Float64}}, LinearAlgebra.Transpose{Float64,Matrix{Float64}},
              StepRangeLen{Float64,Base.TwicePrecision{Float64},Base.TwicePrecision{Float64},Int}, UnitRange{Int}, ComplexF64,
              Tuple{Int,Float64}, Rational{Int}, Float64, Int, String, Bool, Nothing)
        precompile(print, (PE, T))
        precompile(println, (PE, T))
        precompile(show, (PE, T))
        precompile(show, (IC, TP, T))
        precompile(show, (IOContext{IOBuffer}, TP, T))
        precompile(string, (String, T))
        precompile(tojson, (T,))
        precompile(display_of, (T,))
    end
end

# 事前コンパイル（Main での評価はしない。型を指定してコンパイルだけしておく）
precompile(main, (Int,))
precompile(evaluate, (String,))
precompile(eval_code, (String, String))
precompile(display_of, (Vector{Float64},))
precompile(error_info, (ErrorException, Vector{Union{Ptr{Nothing},Base.InterpreterIP}}, String))
precompile(preload, (Vector{Any},))
precompile(json, (Dict{String,Any},))
precompile(parse_json, (String,))
precompile(softscope, (Expr,))
precompile(utf8_complete, (Vector{UInt8},))
let
    # 値の変換・JSON は Main に触れないので、実際に動かしておく（コンパイル結果が保存される）
    for v in (1, 1.5, 1 + 2im, [1.0 2.0; 3.0 4.0], [1, 2, 3], (1, "a"), "s", nothing, true, 1 // 2)
        tojson(v)
    end
    json(Dict{String,Any}("a" => [1, 2.5, "x", nothing, true], "b" => RawJSON("{}")))
    parse_json("{\"type\":\"run\",\"id\":\"x\",\"code\":\"1 + 1\\n\",\"tests\":[{\"code\":\"f(1)\"}],\"n\":1.5}")
    softscope(Meta.parseall("for i in 1:3\n s += i\nend"; filename="x.jl"))
end

end # module
