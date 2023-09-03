import { ShareAddress } from "../../util/doc-types.ts";
import { ValidationError } from "../../util/errors.ts";
import { Query } from "../../query/query-types.ts";

// types

type SharedSqliteOpts = {
  share:ShareAddress;
  filename:string;
  fs: {
    stat: (path:string) => Promise<boolean>
  }
}

export type ReplicaSqliteOptsCreate = SharedSqliteOpts & {
  mode: "create"
}
export type ReplicaSqliteOptsOpen = SharedSqliteOpts & {
  mode:"open"
}
export type ReplicaSqliteOptsCreateOrOpen = SharedSqliteOpts & {
  mode:'create-or-open'
}

export type ReplicaSqliteOpts =
  | ReplicaSqliteOptsCreate
  | ReplicaSqliteOptsOpen
  | ReplicaSqliteOptsCreateOrOpen;

// SQL queries

export const MAX_LOCAL_INDEX_QUERY = `SELECT MAX(localIndex) from docs;`;

export const UPSERT_CONFIG_QUERY =
  `INSERT OR REPLACE INTO config (key, content) VALUES (:key, :content);`;

export const SELECT_CONFIG_CONTENT_QUERY =
  `SELECT content FROM config WHERE key = :key;`;

export const SELECT_KEY_CONFIG_QUERY = `SELECT key FROM config`;

export const DELETE_CONFIG_QUERY = `DELETE FROM config WHERE key = :key;`;

export const UPSERT_DOC_QUERY =
  `INSERT OR REPLACE INTO docs (doc, localIndex, pathAuthor)
VALUES (:doc, :localIndex, :pathAuthor)`;

export const SELECT_EXPIRED_DOC_QUERY =
  `SELECT doc FROM docs WHERE deleteAfter <= :now`;

export const DELETE_EXPIRED_DOC_QUERY =
  `DELETE FROM docs WHERE deleteAfter <= :now`;

export const SET_ENCODING_QUERY = `PRAGMA encoding = "UTF-8";`;

export const GET_ENCODING_QUERY = `PRAGMA encoding;`;

export const CREATE_DOCS_TABLE_QUERY = `CREATE TABLE IF NOT EXISTS docs (
    doc TEXT NOT NULL,
    pathAuthor TEXT NOT NULL,
    localIndex NUMBER NOT NULL UNIQUE,
    format TEXT GENERATED ALWAYS AS (json_extract(doc, '$.format')) VIRTUAL NOT NULL,
    path TEXT GENERATED ALWAYS AS (json_extract(doc, '$.path')) VIRTUAL NOT NULL,
    author TEXT GENERATED ALWAYS AS (json_extract(doc, '$.author')) VIRTUAL NOT NULL,
    timestamp NUMBER GENERATED ALWAYS AS (json_extract(doc, '$.timestamp')) VIRTUAL NOT NULL,
    signature TEXT GENERATED ALWAYS AS (json_extract(doc, '$.signature')) VIRTUAL NOT NULL,
    deleteAfter NUMBER GENERATED ALWAYS AS (json_extract(doc, '$.deleteAfter')) VIRTUAL,
		PRIMARY KEY(pathAuthor)
);`;

export const CREATE_INDEXES_QUERY =
  `CREATE INDEX IF NOT EXISTS docsFormat ON docs(format); 
   CREATE INDEX IF NOT EXISTS docsPath ON docs(path);
   CREATE INDEX IF NOT EXISTS docsAuthor ON docs(author);
   CREATE INDEX IF NOT EXISTS docsTimestamp ON docs(timestamp);
   CREATE INDEX IF NOT EXISTS docsSignature ON docs(signature);
   CREATE INDEX IF NOT EXISTS docsDeleteAfter ON docs(deleteAfter);
   CREATE INDEX IF NOT EXISTS docsLocalIndex ON docs(localIndex);
   CREATE INDEX IF NOT EXISTS docsPathAuthor ON docs(pathAuthor);
  `;

export const CREATE_CONFIG_TABLE_QUERY = `CREATE TABLE IF NOT EXISTS config (
		key TEXT NOT NULL PRIMARY KEY,
		content TEXT NOT NULL
);`;

// utilities

export function makeDocQuerySql(
  query: Query<string[]>,
  now: number,
  mode: "documents" | "delete",
): { sql: string; params: Record<string, any> } {
  /**
   * Internal function to make SQL to query for documents or paths,
   * or delete documents matching a query.
   *
   * Assumes query has already been through cleanUpQuery(q).
   *
   * If query.history === 'all', we can do an easy query:
   *
   * ```
   *     SELECT * from DOCS
   *     WHERE path = "/abc"
   *         AND timestamp > 123
   *     ORDER BY path ASC, author ASC
   *     LIMIT 123
   * ```
   *
   * If query.history === 'latest', we have to do something more complicated.
   * We don't want to filter out some docs, and THEN get the latest REMAINING
   * docs in each path.
   * We want to first get the latest doc per path, THEN filter those.
   *
   * ```
   *     SELECT *, MAX(timestamp) from DOCS
   *     -- first level of filtering happens before we choose the latest doc.
   *     -- here we can only do things that are the same for all docs in a path.
   *     WHERE path = "/abc"
   *     -- now group by path and keep the newest one
   *     GROUP BY path
   *     -- finally, second level of filtering happens AFTER we choose the latest doc.
   *     -- these are things that can differ for docs within a path
   *     HAVING timestamp > 123
   *     ORDER BY path ASC, author ASC
   *     LIMIT 123
   * ```
   */

  let select = "";
  let from = "FROM docs";
  let wheres: string[] = [];
  let groupBy = "";
  let havings: string[] = [];
  let orderBy = "";
  let limit = "";

  switch (query.orderBy) {
    case "path ASC":
      //   "path ASC" is actually "path ASC then break ties with timestamp DESC"
      orderBy = "ORDER BY path ASC, timestamp DESC";
      break;
    case "path DESC":
      //   "path DESC" is the reverse of that
      orderBy = "ORDER BY path DESC, timestamp ASC";
      break;
    case "localIndex ASC":
      orderBy = "ORDER BY localIndex ASC";
      break;
    case "localIndex DESC":
      orderBy = "ORDER BY localIndex DESC";
      break;
  }

  const params: Record<string, any> = {};
  let sql = "";

  if (mode === "documents") {
    if (query.historyMode === "all") {
      select = "SELECT *";
    } else if (query.historyMode === "latest") {
      // We're going to GROUP BY path and want to get the doc with the highest timestamp.
      // To break timestamp ties, we'll use the signature.
      // Because we need to look at multiple columns to choose the winner of the group
      // we can't just do MAX(timestamp), we have to do this silly thing instead:
      // TODO: test sorting by signature when timestamp is tied
      select =
        "SELECT *, MIN(CAST(9999999999999999 - timestamp AS TEXT) || signature) AS toSortWithinPath";
      //select = 'SELECT *, MAX(timestamp) AS toSortWithinPath';
      groupBy = "GROUP BY path";
    } else {
      throw new ValidationError(
        `unexpected query.historyMode = ${query.historyMode}`,
      );
    }
  } else if (mode === "delete") {
    if (query.historyMode === "all") {
      select = "DELETE";
    } else {
      throw new ValidationError(
        `query.history must be "all" when doing forgetDocuments`,
      );
    }
  } else {
    // if (mode === 'paths') {

    throw new Error("unknown mode to _makeDocQuerySql: " + mode);
    //select = 'SELECT DISTINCT path';
  }

  // parts of the query that are the same for all docs in a path can go in WHERE.

  if (query.filter?.path !== undefined) {
    wheres.push("path = :path");
    params.path = query.filter.path;
  }
  // If we have pathStartsWith AND pathEndsWith we would want to optimize them
  // into a single filter, path LIKE (:startsWith || '%' || :endsWith).
  // BUT we can't do that because we are allowing the prefix and suffix
  // to potentially overlap,
  // leaving no room in the middle for the wildcard to match anything.
  // So this has to be left as two separate filter clauses.
  if (query.filter?.pathStartsWith !== undefined) {
    // Escape existing % and _ in the prefix so they don't count as wildcards for LIKE.
    // TODO: test this
    wheres.push("path LIKE (:startsWith || '%') ESCAPE '\\'");
    params.startsWith = query.filter.pathStartsWith
      .split("_")
      .join("\\_")
      .split("%")
      .join("\\%");
  }
  if (query.filter?.pathEndsWith !== undefined) {
    // Escape existing % and _ in the suffix so they don't count as wildcards for LIKE.
    // TODO: test this
    wheres.push("path LIKE ('%' || :endsWith) ESCAPE '\\'");
    params.endsWith = query.filter.pathEndsWith
      .split("_")
      .join("\\_")
      .split("%")
      .join("\\%");
  }

  // parts of the query that differ across docs in the same path
  // may have to go in HAVING if we're doing a GROUP BY.
  if (query.filter?.timestamp !== undefined) {
    havings.push("timestamp = :timestamp");
    params.timestamp = query.filter.timestamp;
  }
  if (query.filter?.timestampGt !== undefined) {
    havings.push("timestamp > :timestampGt");
    params.timestampGt = query.filter.timestampGt;
  }
  if (query.filter?.timestampLt !== undefined) {
    havings.push("timestamp < :timestampLt");
    params.timestampLt = query.filter.timestampLt;
  }
  if (query.filter?.author !== undefined) {
    havings.push("author = :author");
    params.author = query.filter.author;
  }

  if (query.startAfter !== undefined) {
    if (query.orderBy?.startsWith("path ")) {
      havings.push("path > :continuePath");
      params.continuePath = query.startAfter.path;
    } else if (query.orderBy?.startsWith("localIndex ")) {
      havings.push("localIndex > :continueLocalIndex");
      params.continueLocalIndex = query.startAfter.localIndex;
    }
  }

  if (query.limit !== undefined && mode !== "delete") {
    limit = "LIMIT :limit";
    params.limit = query.limit;
  }

  // limitBytes is skipped here since it can't be expressed in SQL.
  // it's applied after the query is run, and only for docs (not paths).

  // filter out expired docs.
  // to pretend they don't exist at all, we use WHERE instead of HAVING.
  // otherwise they might end up as a latest doc of a group,
  // and then disqualify that group.
  wheres.push("(deleteAfter IS NULL OR :now <= deleteAfter)");
  params.now = now;

  // assemble the final sql

  // in 'all' mode, we don't need to use HAVING, we can do all the filters as WHERE.
  if (query.historyMode === "all") {
    wheres = wheres.concat(havings);
    havings = [];
  }

  const allWheres = wheres.length === 0
    ? ""
    : "WHERE " + wheres.join("\n  AND ");
  const allHavings = havings.length === 0
    ? ""
    : "HAVING " + havings.join("\n  AND ");

  sql = `
			${select}
			${from}
			${allWheres}
			${groupBy}
			${allHavings}
			${orderBy}
			${limit};
	`;

  return { sql, params };
}
