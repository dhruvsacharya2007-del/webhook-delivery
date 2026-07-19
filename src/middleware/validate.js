const { AppError } = require('./errorHandler');

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
      headers: req.headers,
    });

    if (!result.success) {
      
      const fieldErrors = {};
      for (const issue of result.error.issues) {
        const key = issue.path.slice(1).join('.') || issue.path.join('.');
        (fieldErrors[key] ||= []).push(issue.message);
      }

      throw new AppError(400, 'Validation failed', fieldErrors);
    }

    
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    if (result.data.query !== undefined) req.validatedQuery = result.data.query;

    next();
  };
}

module.exports = { validate };