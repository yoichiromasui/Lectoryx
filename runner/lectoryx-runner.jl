#!/usr/bin/env julia
# =============================================================
# Lectoryx ローカル実行ツール
#   学生の PC の公式 Julia で、Lectoryx（ブラウザ）の演習コードを実行・採点する。
#   Julia の標準ライブラリだけで動く（追加のパッケージ・Python・Node.js は不要）。
#
#   julia lectoryx-runner.jl [オプション]
#     --port N            待ち受けるポート（既定 27182。127.0.0.1 だけで待ち受ける）
#     --allow-origin URL  接続を許すページの Origin（複数可。既定は lectoryx-runner.toml の origins）
#     --app URL           ペアリングで開くページ（既定は lectoryx-runner.toml の app）
#     --open              起動したらブラウザでペアリング用のページを開く（Mac は Safari を避けて Chrome・Edge・Firefox など）
#     --browser NAME      --open で使うブラウザ（Mac はアプリ名 "Google Chrome" など、Windows は chrome / edge / firefox）
#     --serve DIR         DIR を http://127.0.0.1:N/app/ で配信する（Safari 用のローカル版）
#     --pool N            環境ごとに待機させておく Julia の数（既定 2）
#     --new-token         合言葉（トークン）を作り直す（前のペアリングは無効になる）
#     --home DIR          作業フォルダ（既定 ~/.lectoryx。環境 LECTORYX_HOME でも指定できる）
#     --batch IN OUT      待ち受けずに、IN（JSON）の仕事を実行して OUT に書く（教材の期待値づくり。tools/exercise.py）
#
#   同じフォルダの lectoryx-runner.toml（配布用の zip に入る）に、配信元のアプリの URL と Origin を書く：
#     app = "https://<アカウント>.github.io/Lectoryx/"
#     origins = ["https://<アカウント>.github.io"]
#
# 安全のための仕組み
#   ・127.0.0.1 だけで待ち受ける（ほかの PC からは接続できない）
#   ・Host ヘッダーを確かめる（DNS rebinding 対策）
#   ・WebSocket の Origin を許可リストと照合する（ほかのサイトからは接続できない）
#   ・最初のメッセージで合言葉（トークン）を確かめる（同じ PC のほかの利用者・ほかのソフトから使われないように）
#     合言葉は ~/.lectoryx/token に保存し、ペアリング用 URL の # 以降（サーバに送られない部分）でページに渡す
# =============================================================
using Sockets, SHA, Base64, Random, Dates, TOML
include(joinpath(@__DIR__, "pkgs", "LectoryxWorker", "src", "MiniJSON.jl"))
using .MiniJSON

const RUNNER_VERSION = "0.2.0"
const PROTOCOL = 1
const DEFAULT_PORT = 27182
const DEFAULT_ORIGINS = ["https://yoichiromasui.github.io"]
const DEFAULT_APP = "https://yoichiromasui.github.io/Lectoryx/"
const JULIA = joinpath(Sys.BINDIR, Base.julia_exename())
const WORKER_PKGS = joinpath(@__DIR__, "pkgs")     # LectoryxWorker（ワーカー。事前コンパイルして起動を速くする）
const MAX_MESSAGE = 8 * 1024 * 1024

Base.@kwdef mutable struct Config
    port::Int = DEFAULT_PORT
    origins::Vector{String} = String[]
    app::String = DEFAULT_APP
    open::Bool = false
    serve::String = ""
    pool::Int = 2
    newtoken::Bool = false
    home::String = get(ENV, "LECTORYX_HOME", joinpath(homedir(), ".lectoryx"))
    batch::Vector{String} = String[]
    browser::String = ""
end

const CFG = Config()
const TOKEN = Ref("")
logmsg(s...) = println(Dates.format(now(), "HH:MM:SS"), "  ", s...)

# ---------------------------------------------------------------- 設定
"""配布用の設定（同じフォルダの lectoryx-runner.toml）。なければ既定値"""
function load_config()
    f = joinpath(@__DIR__, "lectoryx-runner.toml")
    c = isfile(f) ? (try TOML.parsefile(f) catch e; println("lectoryx-runner.toml を読めません: ", sprint(showerror, e)); Dict() end) : Dict()
    app = string(get(c, "app", DEFAULT_APP))
    origins = [rstrip(string(o), '/') for o in get(c, "origins", DEFAULT_ORIGINS)]
    return app, origins
end

function parse_args(args)
    CFG.app, default_origins = load_config()
    i = 1
    while i <= length(args)
        a = args[i]
        val() = (i += 1; i <= length(args) ? args[i] : error("$a の値がありません"))
        if a == "--port"; CFG.port = parse(Int, val())
        elseif a == "--allow-origin"; push!(CFG.origins, rstrip(val(), '/'))
        elseif a == "--app"; CFG.app = val()
        elseif a == "--open"; CFG.open = true
        elseif a == "--serve"; CFG.serve = abspath(val())
        elseif a == "--pool"; CFG.pool = max(0, parse(Int, val()))
        elseif a == "--new-token"; CFG.newtoken = true
        elseif a == "--home"; CFG.home = abspath(val())
        elseif a == "--browser"; CFG.browser = val()
        elseif a == "--batch"; CFG.batch = [abspath(val()), abspath(val())]
        elseif a in ("-h", "--help")
            println(join(collect(Iterators.takewhile(l -> startswith(l, "#"), split(read(@__FILE__, String), '\n')))[2:end], '\n'))
            exit(0)
        else
            error("不明なオプション: $a")
        end
        i += 1
    end
    isempty(CFG.origins) && append!(CFG.origins, default_origins)
    # ローカル版（--serve）のページは同じ Origin から接続する
    append!(CFG.origins, ["http://127.0.0.1:$(CFG.port)", "http://localhost:$(CFG.port)"])
end

function load_token()
    mkpath(CFG.home)
    f = joinpath(CFG.home, "token")
    if CFG.newtoken || !isfile(f)
        write(f, bytes2hex(rand(RandomDevice(), UInt8, 24)))
        Sys.isunix() && chmod(f, 0o600)
    end
    TOKEN[] = strip(read(f, String))
end

same(a::AbstractString, b::AbstractString) = ncodeunits(a) == ncodeunits(b) && reduce(|, codeunits(a) .⊻ codeunits(b); init=0x00) == 0x00

# ---------------------------------------------------------------- 環境（Project.toml / Manifest.toml）
mutable struct Worker
    proc::Base.Process
    secret::String
    env::Any
    sock::Union{TCPSocket,Nothing}
    inbox::Channel{Dict{String,Any}}
    started::Float64
    killed::Bool
end

mutable struct Env
    key::String
    name::String
    dir::String
    state::Symbol                  # :ready :installing :error
    packages::Vector{Dict{String,Any}}
    pool::Channel{Worker}
    spawning::Int
    log::Vector{String}
    lock::ReentrantLock
    waiters::Vector{Any}           # インストール完了を待っているクライアント
    warn::String
    failures::Int                  # 続けて起動に失敗した回数
    lastused::Float64              # 最後に使った時刻（使っていない環境の待機中の Julia は片付ける）
end

const IDLE_SECONDS = 600

"""しばらく（10 分）使っていない環境の待機中の Julia を片付けて、メモリを返す（使うときに用意し直す）"""
function trim_pools()
    while true
        sleep(30)
        for env in collect(values(ENVS))
            time() - env.lastused > IDLE_SECONDS || continue
            n = 0
            while isready(env.pool)
                kill_worker(take!(env.pool))
                n += 1
            end
            n > 0 && logmsg("しばらく使っていないので待機中の Julia を片付けました（$(env.key)、$(n) 個）")
        end
    end
end

const ENVS = Dict{String,Env}()
const ENVS_LOCK = ReentrantLock()
const PENDING = Dict{String,Worker}()    # 合言葉 → 接続待ちのワーカー
const ALL_WORKERS = Set{Worker}()
const INTERNAL_PORT = Ref(0)

function direct_packages(dir)
    f = joinpath(dir, "Project.toml")
    isfile(f) || return Dict{String,Any}[]
    deps = get(TOML.parsefile(f), "deps", Dict())
    return [Dict{String,Any}("name" => k, "uuid" => v) for (k, v) in deps]
end

function make_env(key, name, dir; state=:ready)
    Env(key, name, dir, state, direct_packages(dir), Channel{Worker}(Inf), 0, String[], ReentrantLock(), Any[], "", 0, time())
end

function base_env()
    lock(ENVS_LOCK) do
        get!(ENVS, "base") do
            dir = joinpath(CFG.home, "envs", "base")
            mkpath(dir)
            isfile(joinpath(dir, "Project.toml")) || write(joinpath(dir, "Project.toml"), "")
            make_env("base", "base", dir)
        end
    end
end

"""
教材の環境を用意する（初回だけ Pkg.instantiate と precompile。以後はオフラインで使える）。
warmup（教員が書く「よく使う呼び出し」。関数の本体として書く）があれば、環境を小さなパッケージ LectoryxEnv にして
事前コンパイルのときに一度実行し、コンパイル結果を保存する（最初の step などが 14 秒かかる問題への対策）。
"""
function ensure_env(name::String, project::String, manifest::String, warmup::String, notify)
    occursin(r"^[A-Za-z0-9_-]{1,40}$", name) || error("環境の名前が正しくありません: $name")
    key = name * "-" * bytes2hex(sha256(project * "\0" * manifest * "\0" * warmup))[1:12]
    env, isnew = lock(ENVS_LOCK) do
        haskey(ENVS, key) && return (ENVS[key], false)
        dir = joinpath(CFG.home, "envs", key)
        ready = isfile(joinpath(dir, ".ready"))
        e = make_env(key, name, dir; state=ready ? :ready : :installing)
        ENVS[key] = e
        (e, !ready)
    end
    if isnew
        mkpath(env.dir)
        write(joinpath(env.dir, "Project.toml"), project)
        isempty(manifest) || write(joinpath(env.dir, "Manifest.toml"), manifest)
        env.warn = version_warning(manifest)
        isempty(strip(warmup)) || write_warmup_package(env, project, warmup)
        @async install_env(env, notify)
    end
    env.packages = preload_list(env)
    return env
end

warmup_uuid(key) = string(Base.UUID((parse(UInt128, bytes2hex(sha256("lectoryx-env:" * key))[1:32], base=16) & ~(UInt128(0xf) << 76)) | (UInt128(4) << 76)))

"""環境を LectoryxEnv というパッケージにして、ウォームアップを事前コンパイルに含める"""
function write_warmup_package(env::Env, project::String, warmup::String)
    p = TOML.parse(project)
    haskey(p, "name") && return                     # すでにパッケージになっている環境はそのまま
    deps = collect(keys(get(p, "deps", Dict())))
    write(joinpath(env.dir, "Project.toml"), "name = \"LectoryxEnv\"\nuuid = \"$(warmup_uuid(env.key))\"\n\n" * project)
    mkpath(joinpath(env.dir, "src"))
    body = join(("    " * l for l in split(warmup, '\n')), "\n")
    write(joinpath(env.dir, "src", "LectoryxEnv.jl"), """
    # 連携ツールが作るファイル（教材の warmup.jl から）。事前コンパイルのときにウォームアップを一度実行して、結果を保存する
    module LectoryxEnv
    $(isempty(deps) ? "" : "using " * join(sort(deps), ", "))
    function _workload()
    $body
        return nothing
    end
    if ccall(:jl_generating_output, Cint, ()) == 1
        Base.Experimental.@force_compile
        try
            _workload()
        catch e
            @warn "ウォームアップに失敗しました" exception = e
        end
    end
    end
    """)
end

"""待機中の Julia が先に読み込んでおくパッケージ（環境の直接の依存と、ウォームアップ）"""
function preload_list(env::Env)
    list = direct_packages(env.dir)
    if isfile(joinpath(env.dir, "src", "LectoryxEnv.jl"))
        push!(list, Dict{String,Any}("name" => "LectoryxEnv", "uuid" => warmup_uuid(env.key), "workload" => true))
    end
    return list
end

function version_warning(manifest)
    isempty(manifest) && return ""
    jv = try get(TOML.parse(manifest), "julia_version", "") catch; "" end
    isempty(jv) && return ""
    v = VersionNumber(jv)
    (v.major, v.minor) == (VERSION.major, VERSION.minor) && return ""
    return "教材の環境は Julia $(v.major).$(v.minor) で作られています（この PC は $(VERSION)）。動かない場合は Julia の版をそろえてください。"
end

function install_env(env::Env, notify)
    logmsg("環境を準備しています: $(env.key)")
    cmd = `$JULIA --startup-file=no --history-file=no --project=$(env.dir) -e "using Pkg; Pkg.instantiate(); Pkg.precompile()"`
    out = Pipe()
    t0 = time()
    proc = run(pipeline(addenv(cmd, "JULIA_PKG_PRECOMPILE_AUTO" => "1"); stdout=out, stderr=out); wait=false)
    close(out.in)
    for line in eachline(out)
        line = replace(line, r"\e\[[0-9;]*[A-Za-z]" => "")
        isempty(strip(line)) && continue
        push!(env.log, line)
        notify(Dict("type" => "env-log", "env" => env.key, "text" => line))
    end
    wait(proc)
    if success(proc)
        write(joinpath(env.dir, ".ready"), string(now()))
        env.state = :ready
        logmsg("環境の準備ができました: $(env.key)（$(round(time() - t0, digits=1)) 秒）")
        fill_pool(env)
    else
        env.state = :error
        logmsg("環境を準備できませんでした: $(env.key)")
    end
    notify(Dict("type" => "env-status", "env" => env.key, "state" => String(env.state), "seconds" => round(time() - t0, digits=1), "warn" => env.warn))
end

# ---------------------------------------------------------------- ワーカー（使い捨ての Julia プロセス）
function spawn_worker(env::Env)
    secret = bytes2hex(rand(RandomDevice(), UInt8, 16))
    sep = Sys.iswindows() ? ";" : ":"
    cmd = `$JULIA --startup-file=no --history-file=no -q --project=$(env.dir) -e "using LectoryxWorker; LectoryxWorker.main()" $(INTERNAL_PORT[])`
    # 学生の普段の環境（@v1.x）のパッケージは見せない（教材の環境・ワーカー・標準ライブラリだけ）
    cmd = addenv(cmd, "JULIA_LOAD_PATH" => "@$(sep)$(WORKER_PKGS)$(sep)@stdlib", "JULIA_NUM_THREADS" => "1")
    workdir = joinpath(CFG.home, "work")
    mkpath(workdir)
    cmd = Cmd(cmd; dir=workdir)
    inp = Pipe()
    logf = joinpath(CFG.home, "worker.log")
    proc = run(pipeline(cmd; stdin=inp, stdout=logf, stderr=logf, append=true); wait=false)
    w = Worker(proc, secret, env, nothing, Channel{Dict{String,Any}}(Inf), time(), false)
    lock(ENVS_LOCK) do
        PENDING[secret] = w
        push!(ALL_WORKERS, w)
    end
    write(inp, secret, "\n")
    close(inp)
    @async begin   # プロセスが終わったら知らせる
        wait(proc)
        put!(w.inbox, Dict{String,Any}("type" => "exit", "code" => proc.exitcode))
        lock(ENVS_LOCK) do
            delete!(ALL_WORKERS, w)
            delete!(PENDING, w.secret)
        end
    end
    return w
end

function kill_worker(w::Worker)
    w.killed = true
    try
        process_running(w.proc) && kill(w.proc, Base.SIGKILL)
    catch
    end
    try
        w.sock === nothing || close(w.sock)
    catch
    end
end

"""待機中の Julia を目標の数までそろえる"""
function fill_pool(env::Env; atleast::Int=0)
    env.state === :ready || return
    n = lock(env.lock) do
        k = max(0, max(CFG.pool, atleast) - Base.n_avail(env.pool) - env.spawning)
        env.spawning += k
        k
    end
    for _ in 1:n
        @async begin
            w = spawn_worker(env)
            try
                msg = take!(w.inbox)
                if msg["type"] == "ready"
                    logmsg("待機中の Julia を用意しました（$(env.key)、$(round(time() - w.started, digits=2)) 秒、パッケージ $(length(msg["loaded"])) 個）")
                    env.failures = 0
                    put!(env.pool, w)
                else
                    env.failures += 1
                    logmsg("Julia を起動できませんでした（$(env.key)、$(env.failures) 回目）。~/.lectoryx/worker.log を見てください")
                    # 受け取りを待っている仕事に知らせる（何度も失敗するならエラーにする）
                    env.failures >= 3 ? put!(env.pool, w) : fill_pool(env; atleast=1)
                end
            finally
                lock(() -> env.spawning -= 1, env.lock)
            end
        end
    end
end

"""待機中の Julia を 1 つ受け取る（なければ起動を待つ）。受け取ったら次を補充する"""
function acquire(env::Env)
    env.lastused = time()
    while true
        fill_pool(env; atleast=1)          # 待機中も起動中もなければ 1 つ起動する
        w = take!(env.pool)
        if process_running(w.proc)
            fill_pool(env)                 # 使った分を補充する
            return w
        end
        env.failures >= 3 && error("Julia を起動できません（3 回続けて失敗しました）。~/.lectoryx/worker.log を見てください")
    end
end

function accept_workers(server)
    while true
        sock = accept(server)
        @async try
            line = readline(sock)
            msg = parse_json(line)
            w = lock(ENVS_LOCK) do
                pop!(PENDING, string(get(msg, "secret", "")), nothing)
            end
            if w === nothing
                close(sock)
                return
            end
            w.sock = sock
            @async begin
                try
                    while isopen(sock)
                        l = readline(sock)
                        isempty(l) && eof(sock) && break
                        m = parse_json(l)
                        m["type"] == "log" ? logmsg("[julia] ", m["text"]) : put!(w.inbox, m)
                    end
                catch
                end
            end
            to_worker(w, Dict("type" => "preload", "packages" => w.env.packages))
        catch e
            close(sock)
        end
    end
end

to_worker(w::Worker, d) = (write(w.sock, json(d), '\n'); flush(w.sock))

# ---------------------------------------------------------------- 仕事（実行・採点）
mutable struct Job
    id::String
    worker::Union{Worker,Nothing}
    interrupted::Bool
end
const JOBS = Dict{String,Job}()

function failure(reason, timeout_ms)
    msg = reason === :timeout ? "制限時間（$(round(timeout_ms / 1000, digits=1)) 秒）を超えたので止めました。無限ループになっていないか確認してください。" :
          reason === :interrupted ? "実行を止めました。" : "Julia のプロセスが終了しました（exit を呼んだか、メモリ不足などで異常終了しました）。"
    Dict{String,Any}("ok" => false, "output" => "", "timedOut" => reason === :timeout, "stopped" => reason === :interrupted,
        "error" => Dict("type" => String(reason), "message" => msg, "line" => nothing, "trace" => String[]))
end

"""1 つのコードを実行する（出力は少しずつ送る）"""
function job_run(send, env::Env, id::String, code::String, timeout_ms::Int)
    job = Job(id, nothing, false)
    JOBS[id] = job
    t0 = time()
    w = acquire(env)
    job.worker = w
    job.interrupted && (kill_worker(w); delete!(JOBS, id); send(merge(failure(:interrupted, timeout_ms), Dict("type" => "result", "id" => id))); return)
    timedout = Ref(false)
    timer = Timer(timeout_ms / 1000) do _
        timedout[] = true
        kill_worker(w)
    end
    to_worker(w, Dict("type" => "run", "id" => id, "code" => code))
    try
        while true
            msg = take!(w.inbox)
            if msg["type"] == "output"
                send(msg)
            elseif msg["type"] == "result"
                msg["wall"] = round((time() - t0) * 1000, digits=1)
                send(msg)
                break
            elseif msg["type"] == "exit"
                r = failure(timedout[] ? :timeout : job.interrupted ? :interrupted : :crashed, timeout_ms)
                send(merge(r, Dict("type" => "result", "id" => id)))
                break
            end
        end
    finally
        close(timer)
        kill_worker(w)
        delete!(JOBS, id)
    end
end

"""学生のコードを実行してから、テストのコードを順に実行する。テストごとに制限時間を設け、
超えたらそのテストを不合格にして、新しい Julia で学生のコードからやり直して続ける"""
function job_tests(send, env::Env, id::String, code::String, tests::Vector, timeout_ms::Int)
    job = Job(id, nothing, false)
    JOBS[id] = job
    n = length(tests)
    start = 1
    base_sent = false
    try
        while start <= n || !base_sent
            w = acquire(env)
            job.worker = w
            timedout = Ref(false)
            timer = Ref(Timer(timeout_ms / 1000) do _
                timedout[] = true
                kill_worker(w)
            end)
            restart_timer() = (close(timer[]); timer[] = Timer(timeout_ms / 1000) do _
                timedout[] = true
                kill_worker(w)
            end)
            to_worker(w, Dict("type" => "tests", "id" => id, "code" => code, "tests" => tests[start:end]))
            current = 0          # 0 = 学生のコード、i = start+i-1 番目のテスト
            finished = false
            while true
                msg = take!(w.inbox)
                t = msg["type"]
                if t == "base"
                    if !base_sent
                        send(msg)
                        base_sent = true
                    end
                    msg["ok"] || (start = n + 1; finished = true)
                    current = 1
                    restart_timer()
                elseif t == "test"
                    msg["index"] = start + msg["index"] - 1
                    send(msg)
                    current = msg["index"] - start + 2
                    restart_timer()
                elseif t == "done"
                    start = n + 1
                    finished = true
                    break
                elseif t == "exit"
                    reason = timedout[] ? :timeout : job.interrupted ? :interrupted : :crashed
                    if current == 0
                        # 学生のコードの途中で止まった → すべてのテストが不合格
                        base_sent || send(merge(failure(reason, timeout_ms), Dict("type" => "base", "id" => id)))
                        base_sent = true
                        start = n + 1
                    else
                        idx = start + current - 1
                        send(merge(failure(reason, timeout_ms), Dict("type" => "test", "id" => id, "index" => idx)))
                        start = idx + 1
                        job.interrupted && (start = n + 1)
                    end
                    break
                end
            end
            close(timer[])
            kill_worker(w)
            finished && break
        end
    finally
        delete!(JOBS, id)
        send(Dict("type" => "tests-done", "id" => id))
    end
end

function interrupt(id)
    job = get(JOBS, id, nothing)
    job === nothing && return
    job.interrupted = true
    job.worker === nothing || kill_worker(job.worker)
end

# ---------------------------------------------------------------- HTTP と WebSocket（127.0.0.1 だけ）
struct Request
    method::String
    target::String
    headers::Dict{String,String}
end

function read_request(io)
    line = readline(io)
    parts = split(line, ' ')
    length(parts) == 3 || return nothing
    headers = Dict{String,String}()
    for _ in 1:100
        l = readline(io)
        isempty(l) && return Request(parts[1], parts[2], headers)
        ncodeunits(l) > 8192 && return nothing
        k, v = something(findfirst(':', l), 0) > 0 ? (l[1:findfirst(':', l)-1], l[findfirst(':', l)+1:end]) : (l, "")
        headers[lowercase(strip(k))] = strip(v)
    end
    return nothing
end

function respond(io, status, headers, body=""; head=false)
    b = Vector{UInt8}(codeunits(body))
    write(io, "HTTP/1.1 $status\r\n")
    for (k, v) in headers
        write(io, "$k: $v\r\n")
    end
    write(io, "Content-Length: $(length(b))\r\nConnection: close\r\n\r\n")
    head || write(io, b)
    flush(io)
end

host_ok(h) = h in ("127.0.0.1:$(CFG.port)", "localhost:$(CFG.port)", "[::1]:$(CFG.port)")
origin_ok(o) = o !== nothing && o in CFG.origins

function cors(o)
    origin_ok(o) || return Dict{String,String}()
    Dict("Access-Control-Allow-Origin" => o, "Vary" => "Origin", "Access-Control-Allow-Methods" => "GET",
         "Access-Control-Allow-Headers" => "Content-Type", "Access-Control-Allow-Private-Network" => "true")
end

const MIME_TYPES = Dict(".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8",
    ".json" => "application/json; charset=utf-8", ".svg" => "image/svg+xml", ".png" => "image/png", ".wasm" => "application/wasm",
    ".woff2" => "font/woff2", ".toml" => "text/plain; charset=utf-8", ".webmanifest" => "application/manifest+json")

function serve_static(io, req, path)
    rel = path == "" ? "index.html" : path
    root = CFG.serve
    full = normpath(joinpath(root, rel))
    if !startswith(full, normpath(root) * (Sys.iswindows() ? "\\" : "/")) && full != normpath(root)
        return respond(io, "403 Forbidden", Dict("Content-Type" => "text/plain"), "forbidden")
    end
    isdir(full) && (full = joinpath(full, "index.html"))
    isfile(full) || return respond(io, "404 Not Found", Dict("Content-Type" => "text/plain"), "not found")
    data = read(full)
    ct = get(MIME_TYPES, lowercase(splitext(full)[2]), "application/octet-stream")
    write(io, "HTTP/1.1 200 OK\r\nContent-Type: $ct\r\nContent-Length: $(length(data))\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")
    write(io, data)
    flush(io)
end

function handle(io)
    try
        tm = Timer(15) do _
            close(io)   # 要求を送ってこない接続は閉じる
        end
        req = read_request(io)
        close(tm)
        req === nothing && return close(io)
        if !host_ok(get(req.headers, "host", ""))
            logmsg("拒否：Host が違う（$(get(req.headers, "host", ""))）")
            return respond(io, "403 Forbidden", Dict("Content-Type" => "text/plain"), "forbidden host")
        end
        origin = get(req.headers, "origin", nothing)
        path = first(split(req.target, '?'))
        if path == "/lectoryx/ws" && lowercase(get(req.headers, "upgrade", "")) == "websocket"
            if !origin_ok(origin)
                logmsg("拒否：許可していないページからの接続（Origin: $(something(origin, "なし"))）")
                return respond(io, "403 Forbidden", Dict("Content-Type" => "text/plain"), "forbidden origin")
            end
            return websocket(io, req, origin)
        elseif req.method == "OPTIONS"
            return respond(io, origin_ok(origin) ? "204 No Content" : "403 Forbidden", cors(origin))
        elseif path == "/lectoryx/info" && req.method in ("GET", "HEAD")
            origin === nothing || origin_ok(origin) || return respond(io, "403 Forbidden", Dict("Content-Type" => "text/plain"), "forbidden origin")
            body = json(Dict("name" => "lectoryx-runner", "version" => RUNNER_VERSION, "protocol" => PROTOCOL))
            return respond(io, "200 OK", merge(Dict("Content-Type" => "application/json", "Cache-Control" => "no-store"), cors(origin)), body; head=req.method == "HEAD")
        elseif !isempty(CFG.serve) && (path == "/" || startswith(path, "/app/"))
            path == "/" && return respond(io, "302 Found", Dict("Location" => "/app/"))
            return serve_static(io, req, replace(path[6:end], "%20" => " "))
        else
            return respond(io, "404 Not Found", Dict("Content-Type" => "text/plain"), "not found")
        end
    catch e
        e isa Base.IOError || e isa EOFError || logmsg("エラー: ", sprint(showerror, e))
    finally
        isopen(io) && close(io)
    end
end

# ---- WebSocket（RFC 6455 の必要な部分だけ）
mutable struct WS
    io::TCPSocket
    lock::ReentrantLock
end

function ws_send(ws::WS, text::String; opcode=0x1)
    data = Vector{UInt8}(codeunits(text))
    n = length(data)
    hdr = UInt8[0x80 | opcode]
    if n < 126
        push!(hdr, UInt8(n))
    elseif n < 65536
        append!(hdr, [0x7e, UInt8(n >> 8), UInt8(n & 0xff)])
    else
        push!(hdr, 0x7f)
        for s in 56:-8:0
            push!(hdr, UInt8((n >> s) & 0xff))
        end
    end
    lock(ws.lock) do
        isopen(ws.io) || return
        write(ws.io, hdr)
        write(ws.io, data)
        flush(ws.io)
    end
end

function ws_read(ws::WS)
    msg = IOBuffer()
    while true
        b1 = read(ws.io, UInt8)
        b2 = read(ws.io, UInt8)
        op = b1 & 0x0f
        masked = (b2 & 0x80) != 0
        len = UInt64(b2 & 0x7f)
        len == 126 && (len = UInt64(ntoh(read(ws.io, UInt16))))
        len == 127 && (len = ntoh(read(ws.io, UInt64)))
        (len > MAX_MESSAGE || position(msg) + len > MAX_MESSAGE) && return nothing
        masked || return nothing                      # ブラウザからのフレームは必ずマスクされる
        mask = read(ws.io, 4)
        data = read(ws.io, Int(len))
        length(data) == len || return nothing
        for i in eachindex(data)
            data[i] ⊻= mask[(i - 1) % 4 + 1]
        end
        if op == 0x8
            ws_send(ws, ""; opcode=0x8)
            return nothing
        elseif op == 0x9
            ws_send(ws, String(data); opcode=0xA)
        elseif op == 0xA
        elseif op == 0x1 || op == 0x0
            write(msg, data)
            (b1 & 0x80) != 0 && return String(take!(msg))
        else
            return nothing                            # バイナリは使わない
        end
    end
end

function websocket(io, req, origin)
    key = get(req.headers, "sec-websocket-key", "")
    isempty(key) && return respond(io, "400 Bad Request", Dict{String,String}())
    accept = base64encode(sha1(key * "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
    write(io, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n")
    flush(io)
    ws = WS(io, ReentrantLock())
    send(d) = try ws_send(ws, json(d)) catch end
    # 最初のメッセージで合言葉を確かめる（10 秒以内）
    tm = Timer(10) do _
        close(io)
    end
    first = ws_read(ws)
    close(tm)
    hello = first === nothing ? nothing : try parse_json(first) catch; nothing end
    if !(hello isa Dict && get(hello, "type", "") == "hello" && same(string(get(hello, "token", "")), TOKEN[]))
        logmsg("拒否：合言葉が違う（$(origin)）")
        sleep(0.5)
        send(Dict("type" => "error", "code" => "auth", "message" => "合言葉（トークン）が違います。ペアリングをやり直してください。"))
        ws_send(ws, ""; opcode=0x8)
        return
    end
    logmsg("接続：$(origin)")
    send(Dict("type" => "welcome", "runner" => RUNNER_VERSION, "protocol" => PROTOCOL, "julia" => string(VERSION),
              "os" => string(Sys.KERNEL), "pool" => CFG.pool, "cpu" => Sys.CPU_THREADS,
              "memoryGB" => round(Sys.total_memory() / 2^30, digits=1)))
    while true
        text = ws_read(ws)
        text === nothing && break
        msg = try parse_json(text) catch; nothing end
        msg isa Dict || continue
        @async dispatch(msg, send)
    end
    logmsg("切断：$(origin)")
end

function dispatch(msg, send)
    t = get(msg, "type", "")
    id = string(get(msg, "id", ""))
    try
        if t == "env"
            env = ensure_env(string(msg["name"]), string(msg["project"]), string(get(msg, "manifest", "")), string(something(get(msg, "warmup", ""), "")), send)
            send(Dict("type" => "env-status", "id" => id, "env" => env.key, "state" => String(env.state), "warn" => env.warn))
            env.state === :ready && fill_pool(env)
        elseif t == "run" || t == "tests"
            envkey = string(get(msg, "env", "base"))
            env = envkey == "base" ? base_env() : get(ENVS, envkey, nothing)
            if env === nothing || env.state !== :ready
                send(Dict("type" => t == "run" ? "result" : "tests-done", "id" => id, "ok" => false,
                          "error" => Dict("type" => "env", "message" => "環境（$envkey）の準備ができていません。")))
                return
            end
            timeout = Int(get(msg, "timeoutMs", 10000))
            if t == "run"
                job_run(send, env, id, string(msg["code"]), timeout)
            else
                job_tests(send, env, id, string(msg["code"]), Vector{Any}(msg["tests"]), timeout)
            end
        elseif t == "interrupt"
            interrupt(id)
        elseif t == "ping"
            send(Dict("type" => "pong", "id" => id))
        end
    catch e
        logmsg("エラー: ", sprint(showerror, e))
        send(Dict("type" => "error", "id" => id, "message" => sprint(showerror, e)))
    end
end

# ---------------------------------------------------------------- 一括実行（教材の期待値づくり）
"""
待ち受けずに、仕事をまとめて実行する（tools/exercise.py が使う。学生の実行・採点と同じ評価の仕方）。
  入力：{ "envs": { 名前: { project, manifest, warmup } },
          "jobs": [ { id, env: 名前 or null, code, tests: [{ code }], timeoutMs } ] }
  出力：{ julia, runner, envs: { 名前: { state, warn, key } }, results: { id: { base, tests: [...] } or { error } } }
"""
function batch(infile::String, outfile::String)
    spec = parse_json(read(infile, String))
    internal = listen(ip"127.0.0.1", 0)
    INTERNAL_PORT[] = Int(getsockname(internal)[2])
    @async accept_workers(internal)
    envinfo = Dict{String,Any}()
    keys_ = Dict{String,String}()
    for (name, e) in get(spec, "envs", Dict{String,Any}())
        println("環境 $name を準備しています（初回だけ数分かかります）")
        flush(stdout)
        env = ensure_env(string(name), string(e["project"]), string(something(get(e, "manifest", ""), "")), string(something(get(e, "warmup", ""), "")),
                         m -> get(m, "type", "") == "env-log" && (println("    ", m["text"]); flush(stdout)))
        while env.state === :installing
            sleep(0.2)
        end
        envinfo[name] = Dict("state" => String(env.state), "warn" => env.warn, "key" => env.key)
        env.state === :ready ? (keys_[name] = env.key) : println("環境 $name を準備できませんでした")
    end
    results = Dict{String,Any}()
    jobs = Vector{Any}(get(spec, "jobs", Any[]))
    asyncmap(jobs; ntasks=max(1, CFG.pool)) do j
        id = string(j["id"])
        envname = get(j, "env", nothing)
        env = envname === nothing ? base_env() : (haskey(keys_, envname) ? ENVS[keys_[envname]] : nothing)
        if env === nothing
            results[id] = Dict("error" => "環境 $(envname) を用意できませんでした")
            return
        end
        tests = Vector{Any}(get(j, "tests", Any[]))
        r = Dict{String,Any}("base" => nothing, "tests" => Any[nothing for _ in tests])
        collect_msg(m) = (t = get(m, "type", ""); t == "base" ? (r["base"] = m) : t == "test" ? (r["tests"][Int(m["index"])] = m) : nothing)
        try
            job_tests(collect_msg, env, id, string(j["code"]), tests, Int(get(j, "timeoutMs", 10000)))
            results[id] = r
        catch e
            results[id] = Dict("error" => sprint(showerror, e))
        end
        nothing
    end
    write(outfile, json(Dict("julia" => string(VERSION), "runner" => RUNNER_VERSION, "envs" => envinfo, "results" => results)))
    foreach(kill_worker, collect(ALL_WORKERS))
end

# ---------------------------------------------------------------- 起動
# Safari は https のページから 127.0.0.1 への接続を禁止しているので、Mac では既定のブラウザ（多くは Safari）ではなく
# 入っている Chrome・Edge・Firefox などでペアリング用のページを開く（--browser で指定もできる）
const MAC_BROWSERS = ["Google Chrome", "Microsoft Edge", "Firefox", "Brave Browser", "Chromium", "Vivaldi"]
const WIN_BROWSERS = Dict("chrome" => "chrome", "google chrome" => "chrome", "edge" => "msedge", "microsoft edge" => "msedge", "firefox" => "firefox")

function mac_browser()
    if !isempty(CFG.browser)
        return CFG.browser
    end
    for name in MAC_BROWSERS, dir in ("/Applications", joinpath(homedir(), "Applications"))
        isdir(joinpath(dir, name * ".app")) && return name
    end
    return nothing
end

"""ペアリング用のページを開く。開いたブラウザの名前（既定のブラウザなら nothing）を返す"""
function open_browser(url)
    try
        if Sys.iswindows()
            exe = get(WIN_BROWSERS, lowercase(CFG.browser), "")
            isempty(exe) ? run(`cmd /c start "" $url`; wait=false) : run(`cmd /c start "" $exe $url`; wait=false)
            return isempty(exe) ? nothing : CFG.browser
        elseif Sys.isapple()
            app = mac_browser()
            app === nothing ? run(`open $url`; wait=false) : run(`open -a $app $url`; wait=false)
            return app
        else
            run(`xdg-open $url`; wait=false)
        end
    catch e
        println("ブラウザを開けませんでした（", sprint(showerror, e), "）。上のペアリング用 URL を Chrome などで開いてください。")
    end
    return nothing
end

function main(args)
    parse_args(args)
    if !isempty(CFG.batch)
        batch(CFG.batch...)
        exit(0)
    end
    load_token()
    internal = listen(ip"127.0.0.1", 0)
    INTERNAL_PORT[] = Int(getsockname(internal)[2])
    @async accept_workers(internal)
    @async trim_pools()
    server = try
        listen(ip"127.0.0.1", CFG.port)
    catch e
        println("ポート $(CFG.port) を使えません（すでに起動していませんか？）: ", sprint(showerror, e))
        exit(1)
    end
    atexit(() -> foreach(kill_worker, collect(ALL_WORKERS)))
    pair = "$(CFG.app)#lectoryx=$(CFG.port).$(TOKEN[])"
    println("""
    ────────────────────────────────────────────
     Lectoryx ローカル実行ツール $(RUNNER_VERSION)（Julia $(VERSION)）
     待ち受け：127.0.0.1:$(CFG.port)（この PC の中だけ）
     接続を許すページ：$(join(filter(o -> !startswith(o, "http://127.0.0.1") && !startswith(o, "http://localhost"), CFG.origins), ", "))
     ペアリング用 URL（このウィンドウは閉じないでください）：
       $(pair)
     ※ Chrome・Edge・Firefox で開いてください（Safari では使えません）。演習に使うブラウザで、この URL を一度開きます。
    $(isempty(CFG.serve) ? "" : " ローカル版：http://127.0.0.1:$(CFG.port)/app/#lectoryx=$(CFG.port).$(TOKEN[])\n")────────────────────────────────────────────""")
    base_env()
    fill_pool(base_env())
    if CFG.open
        app = open_browser(pair)
        if Sys.isapple()
            println(app === nothing ? "Chrome・Edge・Firefox が見つからないので、既定のブラウザで開きました。Safari では使えないので、Chrome などをインストールしてください。" :
                                      "$(app) でペアリング用のページを開きました。")
        end
    end
    while true
        io = accept(server)
        @async handle(io)
    end
end

if abspath(PROGRAM_FILE) == @__FILE__
    main(ARGS)
end
