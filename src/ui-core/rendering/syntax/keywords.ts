import { LangFamily } from "./language-table.js";

export const KW = {
  js: words(`
    as async await break case catch class const continue debugger default delete do else
    enum export extends false finally for from function get if implements import in
    instanceof interface let new null of package private protected public return set static
    super switch this throw true try typeof undefined var void while with yield type keyof
    readonly infer never unknown any boolean number string symbol bigint satisfies asserts
    is namespace module declare abstract override
  `),
  py: words(`
    and as assert async await break class continue def del elif else except False finally
    for from global if import in is lambda None nonlocal not or pass raise return True try
    while with yield match case type
  `),
  go: words(`
    break case chan const continue default defer else fallthrough for func go goto if
    import interface map package range return select struct switch type var true false nil iota
  `),
  rs: words(`
    as async await break const continue crate dyn else enum extern false fn for if impl in
    let loop match mod move mut pub ref return self Self static struct super trait true type
    unsafe use where while async await dyn
  `),
  c: words(`
    auto break case char const continue default do double else enum extern float for goto
    if inline int long register restrict return short signed sizeof static struct switch
    typedef union unsigned void volatile while _Bool _Complex _Imaginary true false NULL
    class public private protected virtual template typename namespace using new delete this
    try catch throw const_cast static_cast dynamic_cast reinterpret_cast constexpr noexcept
    override final nullptr bool wchar_t
  `),
  csharp: words(`
    abstract as base bool break byte case catch char checked class const continue decimal
    default delegate do double else enum event explicit extern false finally fixed float for
    foreach goto if implicit in int interface internal is lock long namespace new null object
    operator out override params private protected public readonly ref return sbyte sealed
    short sizeof stackalloc static string struct switch this throw true try typeof uint ulong
    unchecked unsafe ushort using var virtual void volatile while async await nameof record
    init required nint nuint
  `),
  java: words(`
    abstract assert boolean break byte case catch char class const continue default do double
    else enum extends final finally float for goto if implements import instanceof int
    interface long native new package private protected public return short static strictfp
    super switch synchronized this throw throws transient try void volatile while true false
    null var record sealed permits yields yield non-sealed
  `),
  kotlin: words(`
    as as? break class continue do else false for fun if in !in interface is !is null object
    package return super this throw true try typealias typeof val var when while by catch
    constructor delegate dynamic field file finally get import init param property receiver
    set setparam where actual abstract annotation companion const crossinline data enum
    expect external final infix inline inner internal lateinit noinline open operator out
    override private protected public reified sealed suspend tailrec vararg
  `),
  swift: words(`
    associatedtype class deinit enum extension fileprivate func import init inout internal let
    open operator private protocol public rethrows static struct subscript typealias var break
    case continue default defer do else fallthrough for guard if in repeat return switch where
    while as Any catch false is nil super self Self throw true try async await actor some
  `),
  ruby: words(`
    BEGIN END alias and begin break case class def defined? do else elsif end ensure false
    for if in module next nil not or redo rescue retry return self super then true undef
    unless until when while yield
  `),
  php: words(`
    abstract and array as break callable case catch class clone const continue declare default
    do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit
    extends final finally fn for foreach function global goto if implements include include_once
    instanceof insteadof interface isset list match namespace new or print private protected
    public readonly require require_once return static switch throw trait try unset use var
    while xor yield true false null
  `),
  sql: words(`
    select from where insert into values update set delete create table drop alter index view
    join left right inner outer on and or not null as order by group having limit offset union
    all distinct case when then else end exists in between like is primary key foreign
    references constraint default unique check cascade grant revoke commit rollback transaction
    begin true false with recursive
  `),
  lua: words(`
    and break do else elseif end false for function goto if in local nil not or repeat return
    then true until while
  `),
  perl: words(`
    __DATA__ __END__ __FILE__ __LINE__ __PACKAGE__ and cmp continue do else elsif eq exp for
    foreach ge gt if le lock lt m ne next no or package qq qr qw qx redo require return sub
    tr unless until while xor y my our use local
  `),
  r: words(`
    if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA NA_integer_
    NA_real_ NA_complex_ NA_character_ ... ..1
  `),
  haskell: words(`
    case class data default deriving do else foreign if import in infix infixl infixr instance
    let module newtype of then type where _
  `),
  erlang: words(`
    after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not
    of or orelse receive rem try when xor
  `),
  fortran: words(`
    assign backspace block call close common continue data dimension do else elseif end endfile
    endif enddo entry equivalence external format function goto if implicit inquire integer
    intrinsic open parameter pause print program read real return rewind save stop subroutine
    then write allocate allocatable allocate deallocate module use contains interface pure
    elemental recursive
  `),
  sh: words(`
    if then else elif fi for while until do done case esac in function select time coproc
    true false return exit export local readonly declare typeset alias unalias set unset
    shift break continue source eval exec
  `),
  css: words(`
    important and or not only from to
  `),
} as const;

function words(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

export function keywordSetFor(pathOrExt: string, family: LangFamily): Set<string> {
  const ext = (pathOrExt.split(".").pop() ?? "").toLowerCase();
  if (family === "js") return KW.js;
  if (family === "py") return KW.py;
  if (family === "ruby") return KW.ruby;
  if (family === "php") return KW.php;
  if (family === "sql") return KW.sql;
  if (family === "lua") return KW.lua;
  if (family === "perl") return KW.perl;
  if (family === "r") return KW.r;
  if (family === "haskell") return KW.haskell;
  if (family === "erlang") return KW.erlang;
  if (family === "fortran") return KW.fortran;
  if (family === "sh") return KW.sh;
  if (family === "css") return KW.css;
  if (family === "clike") {
    if (ext === "go") return KW.go;
    if (ext === "rs") return KW.rs;
    if (ext === "cs") return KW.csharp;
    if (ext === "java") return KW.java;
    if (ext === "kt" || ext === "kts") return KW.kotlin;
    if (ext === "swift") return KW.swift;
    if (ext === "dart") return KW.js;
    return KW.c;
  }
  return new Set();
}
