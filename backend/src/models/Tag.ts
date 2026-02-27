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
  BelongsToMany
} from "sequelize-typescript";
import Contact from "./Contact";
import ContactTag from "./ContactTag";

@Table({ tableName: "tags" })
class Tag extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column
  id: number;

  @AllowNull(false)
  @Unique
  @Column
  name: string;

  @Default("#3B82F6")
  @Column
  color: string;

  @BelongsToMany(() => Contact, () => ContactTag)
  contacts: Contact[];

  @CreatedAt
  createdAt: Date;

  @UpdatedAt
  updatedAt: Date;
}

export default Tag;
