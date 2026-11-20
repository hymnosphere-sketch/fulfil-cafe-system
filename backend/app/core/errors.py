"""Error type shared by every layer.

One exception carries the stable error code, HTTP status and safe details
that the API contract (section 13) requires. Routes turn it into the JSON
error envelope; services raise it; tests assert on `.code`.
"""


class ApiError(Exception):
    def __init__(self, code, message, status, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


def invalid_request(message="The request is malformed.", details=None):
    return ApiError("INVALID_REQUEST", message, 400, details)


def validation_error(fields, message="The submitted information is invalid."):
    return ApiError("VALIDATION_ERROR", message, 422, {"fields": fields})
