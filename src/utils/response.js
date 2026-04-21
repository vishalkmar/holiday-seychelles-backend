function sendSuccess(res, data = {}, message = 'Success', statusCode = 200) {
  res.status(statusCode).json({
    status: 'success',
    message,
    data,
  });
}

function sendError(res, error, message = 'Error', statusCode = 400) {
  res.status(statusCode).json({
    status: 'error',
    message,
    error: error?.message || error,
  });
}

module.exports = { sendSuccess, sendError };
