import { Injectable } from '@angular/core';

export interface User {
  id: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class UserService {
  /** Loads one user by id. Used by the user page and by billing. */
  getUser(id: string): User {
    return { id, name: 'User ' + id };
  }

  formatName(name: string): string {
    return name.trim().toUpperCase();
  }
}
