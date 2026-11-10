import { Component } from '@angular/core';
import { UserService, User } from '../services/user.service';

@Component({
  selector: 'app-user',
  templateUrl: './user.component.html'
})
export class UserComponent {
  user?: User;

  constructor(private userService: UserService) {}

  load(id: string): void {
    this.user = this.userService.getUser(id);
  }

  label(): string {
    return this.user ? this.userService.formatName(this.user.name) : '';
  }
}
