import {
  Table,
  Column,
  CreatedAt,
  UpdatedAt,
  Model,
  PrimaryKey,
  AutoIncrement,
  AllowNull,
  Unique,
  Default,
  ForeignKey,
  BelongsTo,
  HasMany,
  BelongsToMany,
  DataType
} from "sequelize-typescript";

import Company from "./Company";
import Ticket from "./Ticket";
import Whatsapp from "./Whatsapp";
import User from "./User";
import Tag from "./Tag";
import ContactTag from "./ContactTag";

@Table({ tableName: "contacts" })
class Contact extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column
  id: number;

  @AllowNull(false)
  @Column
  name: string;

  @AllowNull(false)
  @Unique
  @Column
  number: string;

  @Default("")
  @Column
  email: string;

  @Default("")
  @Column
  profilePicUrl: string;

  @Default(false)
  @Column
  isGroup: boolean;

  @ForeignKey(() => Company)
  @AllowNull(false)
  @Column
  companyId: number;

  @BelongsTo(() => Company)
  company: Company;

  @ForeignKey(() => Whatsapp)
  @Column
  whatsappId: number;

  @BelongsTo(() => Whatsapp)
  whatsapp: Whatsapp;

  // Lead enrichment
  @Column
  source: string;

  @Default("unread")
  @Column
  leadStatus: string;

  @ForeignKey(() => User)
  @Column
  assignedUserId: number;

  @BelongsTo(() => User)
  assignedUser: User;

  @Column(DataType.DATE)
  lastInteractionAt: Date;

  @Default(30)
  @Column
  inactivityMinutes: number;

  @ForeignKey(() => require("./Webhook").default)
  @Column
  inactivityWebhookId: number;

  @Column(DataType.DATE)
  lastInactivityFiredAt: Date;

  @BelongsToMany(() => Tag, () => ContactTag)
  tags: Tag[];

  @HasMany(() => Ticket)
  tickets: Ticket[];

  @CreatedAt
  createdAt: Date;

  @UpdatedAt
  updatedAt: Date;
}

export default Contact;
