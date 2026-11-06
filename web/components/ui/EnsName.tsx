/**
 * An ENS name that wraps only between the worker's label and its parent name, so long names
 * read "tamil-scribe." / "nightshift.eth" on narrow screens instead of breaking mid-name.
 */
export function EnsName({ name }: { name: string }) {
  const dot = name.indexOf(".");
  if (dot < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, dot + 1)}
      <wbr />
      <span className="ens-name__parent">{name.slice(dot + 1)}</span>
    </>
  );
}
