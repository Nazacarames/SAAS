import { Table, Column, Model, ForeignKey, CreatedAt, UpdatedAt, Index } from "sequelize-typescript";
import Contact from "./Contact";
import Tag from "./Tag";

@Table({
  tableName: "contact_tags",
  indexes: [
    { fields: ["contactId"] },
    { fields: ["tagId"] },
    { unique: true, fields: ["contactId", "tagId"] }
  ]
})
class ContactTag extends Model {
  @ForeignKey(() => Contact)
  @Column
  contactId: number;

  @ForeignKey(() => Tag)
  @Column
  tagId: number;

  @CreatedAt
  createdAt: Date;

  @UpdatedAt
  updatedAt: Date;
}

export default ContactTag;
