import {
  Table,
  Column,
  CreatedAt,
  UpdatedAt,
  Model,
  PrimaryKey,
  AutoIncrement,
  AllowNull,
  Default,
  ForeignKey,
  BelongsTo,
  BelongsToMany
} from "sequelize-typescript";
import Company from "./Company";
import Contact from "./Contact";
import ContactTag from "./ContactTag";

@Table({
  tableName: "tags",
  indexes: [{ unique: true, fields: ["companyId", "name"], name: "uq_tags_company_name" }]
})
class Tag extends Model {
  @PrimaryKey
  @AutoIncrement
  @Column
  id: number;

  @ForeignKey(() => Company)
  @AllowNull(false)
  @Column
  companyId: number;

  @BelongsTo(() => Company)
  company: Company;

  @AllowNull(false)
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
