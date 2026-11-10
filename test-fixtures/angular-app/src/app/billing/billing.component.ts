import { Component } from '@angular/core';
import { UserService } from '../services/user.service';

@Component({
  selector: 'app-billing',
  template: '<p>{{ owner }}</p>'
})
export class BillingComponent {
  owner = '';

  constructor(private userService: UserService) {}

  refreshOwner(accountId: string): void {
    this.owner = this.userService.getUser(accountId).name;
  }
}
