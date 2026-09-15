function countRunnableIssues(issues) {
  return issues.filter((issue) => !issue.blocked && !issue.needsClarification)
    .length;
}

function summarizeBoard(issues) {
  return {
    blocked: issues.filter((issue) => issue.blocked).length,
    needsClarification: issues.filter((issue) => issue.needsClarification)
      .length,
    open: issues.length,
    ready: countRunnableIssues(issues),
  };
}

export { countRunnableIssues, summarizeBoard };
