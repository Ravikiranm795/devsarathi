import { Component, Input } from '@angular/core';
import { User } from '../services/user.service';

@Component({
  selector: 'app-user-card',
  template: '<div class="card">{{ user?.name }}</div>'
})
export class UserCardComponent {
  @Input() user?: User;
}
