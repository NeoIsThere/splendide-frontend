import { ErrorHandler, Injectable, Provider, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { PosthogService } from './services/posthog.service';

@Injectable()
class PostHogErrorHandler implements ErrorHandler {
  private readonly posthog = inject(PosthogService);

  handleError(error: unknown): void {
    this.posthog.captureException(this.extractError(error));
    console.error(error);
  }

  private extractError(errorCandidate: unknown): unknown {
    const error = this.unwrapZoneError(errorCandidate);
    if (error instanceof HttpErrorResponse) {
      return this.extractHttpError(error);
    }
    if (typeof error === 'string') {
      return new Error(error);
    }
    if (this.isErrorLike(error)) {
      return error;
    }
    return new Error('Unknown Angular error');
  }

  private unwrapZoneError(error: unknown): unknown {
    return error &&
      typeof error === 'object' &&
      'ngOriginalError' in error &&
      (error as { ngOriginalError?: unknown }).ngOriginalError
      ? (error as { ngOriginalError: unknown }).ngOriginalError
      : error;
  }

  private extractHttpError(error: HttpErrorResponse): Error {
    if (this.isErrorLike(error.error)) {
      return error.error;
    }

    const status = error.status > 0 ? `HTTP ${error.status}` : 'HTTP error';
    const statusText = error.statusText && error.statusText.length > 0 ? ` ${error.statusText}` : '';
    return new Error(`${status}${statusText}`);
  }

  private isErrorLike(value: unknown): value is Error {
    if (value instanceof Error) return true;
    return value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'name' in value &&
      'message' in value &&
      'stack' in value;
  }
}

export function providePostHogErrorHandler(): Provider {
  return {
    provide: ErrorHandler,
    useClass: PostHogErrorHandler,
  };
}
