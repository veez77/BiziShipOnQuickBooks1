/** HTTP-level errors raised by route code; the server's error handler maps each to the contract's error codes. */

export class AlreadyConnectedError extends Error {}

export class BadRequestError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Handle unknown, expired, owned by someone else, or bound to a different shipment. */
export class HandleInvalidError extends Error {}

/** Handle exists but belongs to another document than the path, or the body disagrees with it. */
export class HandleMismatchError extends Error {}
