import { IsNotEmpty, IsString } from 'class-validator';

/** AUTH-05: change the active company without re-authenticating. */
export class SwitchCompanyDto {
  @IsString()
  @IsNotEmpty()
  company_id: string;
}
