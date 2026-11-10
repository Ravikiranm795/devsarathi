import { UserComponent } from './user.component';
import { UserService } from '../services/user.service';

describe('UserComponent', () => {
  it('loads a user through the service', () => {
    const component = new UserComponent(new UserService());
    component.load('7');
    expect(component.label()).toBe('USER 7');
  });
});
